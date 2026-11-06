import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { apply, __testing } from '../index.js'

const { titleFromText } = __testing

const ROUTE = '/session-manual-title/run'

function text(role, value) {
  return { role, content: [{ type: 'text', text: value }] }
}

/**
 * A Host ctx with just what the plugin touches: an effect runner, a route
 * registry, owner admission, a scripted llm, one live session and the title
 * service.
 */
function makeHost({ session, titles, admit, reply = ['Fix the login bug'] }) {
  const calls = { prepare: [], stream: [], renamed: [] }
  const routes = new Map()
  const ctx = {
    effect: (register) => {
      register()
      return () => {}
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      admit: admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })),
    },
    sessions: { get: (id) => (session !== undefined && session.id === id ? session : undefined) },
    get: (key) => (key === 'sessionTitle' ? titles : undefined),
    llm: {
      prepareCall: async (config, signal, configure) => {
        calls.prepare.push({ config, configure: configure === undefined ? undefined : 'fn' })
        return {
          config: {},
          stream: async function* (options) {
            calls.stream.push(options)
            for (const line of reply) yield { type: 'text-delta', text: line }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  return { ctx, routes, calls }
}

function makeRequest(body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))])
  request.method = 'POST'
  request.headers = { 'content-type': 'application/json' }
  return request
}

function makeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    body: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
  return response
}

function makeTitles() {
  const renames = []
  return {
    renames,
    rename(session, title) {
      renames.push({ session, title })
      return { title }
    },
  }
}

async function run(handler, body) {
  const response = makeResponse()
  await handler(makeRequest(body), response)
  return response
}

test('shared mode reuses the main request prefix and inherits its controls', async () => {
  const tools = [{ name: 'read', description: 'Read a file', parameters: {} }]
  const history = [text('user', 'why is login broken?'), text('assistant', 'Looking into it.')]
  const session = {
    id: 's1',
    seq: 9,
    requestHeader: () => ({
      config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', temperature: 0.3 },
      tools,
    }),
    deriveMessages: () => history,
    toolHistory: () => ({ tools, updates: [] }),
  }
  const titles = makeTitles()
  const { ctx, routes, calls } = makeHost({ session, titles })
  apply(ctx, { sharePromptCache: true })

  const response = await run(routes.get(ROUTE), { sessionId: 's1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    ok: true,
    title: 'Fix the login bug',
    mode: 'shared',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  })
  // The controls the main request used must be inherited verbatim, or the
  // shared prefix stops being the cached one.
  const sent = calls.prepare[0].config
  assert.equal(sent.reasoningEffort, 'high')
  assert.equal(sent.temperature, 0.3)
  assert.equal(sent.provider, 'deepseek-account')
  assert.equal(sent.model, 'deepseek-flash')
  // History first, instruction last, tools from the logged header.
  const streamed = calls.stream[0]
  assert.equal(streamed.messages.length, 3)
  assert.deepEqual(streamed.messages.slice(0, 2), history)
  assert.equal(streamed.messages[2].role, 'user')
  assert.match(streamed.messages[2].content[0].text, /name this session/i)
  assert.deepEqual(streamed.tools, tools)
  assert.deepEqual(streamed.toolHistory, { tools, updates: [] })
  assert.equal(titles.renames.length, 1)
  assert.equal(titles.renames[0].title, 'Fix the login bug')
})

test('falls back to a self-contained tail when the prefix cannot be reproduced', async () => {
  const session = {
    id: 's2',
    requestHeader: () => ({
      config: { provider: 'deepseek-account', model: 'deepseek-flash' },
      tools: [],
    }),
    deriveMessages: () => [text('user', 'hello'), text('assistant', 'hi'), text('user', 'name this')],
  }
  const titles = makeTitles()
  const { ctx, routes, calls } = makeHost({ session, titles })
  apply(ctx, { sharePromptCache: true })

  const response = await run(routes.get(ROUTE), { sessionId: 's2' })

  assert.equal(response.status, 200)
  assert.equal(response.body.mode, 'tail')
  // No tools, no inherited effort, one self-contained user message.
  assert.equal(calls.stream[0].tools, undefined)
  assert.equal(calls.stream[0].messages.length, 1)
  assert.equal(calls.stream[0].messages[0].role, 'user')
  assert.match(calls.stream[0].messages[0].content[0].text, /user: hello/)
  assert.match(calls.stream[0].system, /concise title/i)
  assert.equal(titles.renames[0].title, 'Fix the login bug')
})

test('sharePromptCache=false never shares the prefix', async () => {
  const history = [text('user', 'a'), text('assistant', 'b')]
  const session = {
    id: 's3',
    requestHeader: () => ({ config: { provider: 'p', model: 'm' }, tools: [{ name: 't' }] }),
    deriveMessages: () => history,
  }
  const titles = makeTitles()
  const { ctx, routes, calls } = makeHost({ session, titles })
  apply(ctx, { sharePromptCache: false })

  const response = await run(routes.get(ROUTE), { sessionId: 's3' })

  assert.equal(response.body.mode, 'tail')
  assert.equal(calls.stream[0].tools, undefined)
  assert.equal(calls.stream[0].messages.length, 1)
})

test('rejects a peer that is not the owner', async () => {
  const session = { id: 's4', requestHeader: () => ({}), deriveMessages: () => [] }
  const { ctx, routes, calls } = makeHost({
    session,
    titles: makeTitles(),
    admit: () => ({ peer: { principal: { kind: 'guest' } } }),
  })
  apply(ctx, {})

  const response = await run(routes.get(ROUTE), { sessionId: 's4' })

  assert.equal(response.status, 403)
  assert.equal(response.body.error, 'forbidden')
  assert.equal(calls.prepare.length, 0)
})

test('reports unknown sessions and empty conversations without calling the model', async () => {
  const { ctx, routes, calls } = makeHost({ session: undefined, titles: makeTitles() })
  apply(ctx, {})

  const missing = await run(routes.get(ROUTE), { sessionId: 'nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'unknown-session')

  const empty = makeHost({
    session: { id: 's5', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), deriveMessages: () => [] },
    titles: makeTitles(),
  })
  apply(empty.ctx, {})
  const nothing = await run(empty.routes.get(ROUTE), { sessionId: 's5' })
  assert.equal(nothing.status, 422)
  assert.equal(nothing.body.error, 'no-conversation')
  assert.equal(calls.prepare.length, 0)
})

test('keeps the first line and strips model wrappers', () => {
  assert.equal(titleFromText('修复会话标题生成'), '修复会话标题生成')
  assert.equal(titleFromText('**Fix the login bug**'), 'Fix the login bug')
  assert.equal(titleFromText('"Rename a session"'), 'Rename a session')
  assert.equal(titleFromText('Title: Add AI rename'), 'Add AI rename')
  assert.equal(titleFromText('标题：会话手动改名'), '会话手动改名')
  assert.equal(titleFromText('\n\n  Fix the login bug  \nsecond line'), 'Fix the login bug')
  assert.equal(titleFromText(''), '')
})

/**
 * AI rename — Host half.
 *
 * One on-demand auxiliary model call that summarizes the whole session into a
 * title and writes it through the official rename path (`sessionTitle.rename`).
 *
 * Design constraints this file exists to satisfy:
 *
 * - **On demand only.** It registers no `sessionTitle` provider. A provider is
 *   exclusive and is driven by the service on every eligible prompt; this runs
 *   only when the user clicks, so it cannot spend tokens per message.
 * - **Reuse the main request's prefix cache.** The auxiliary request is built
 *   from the exact tools and message history the main loop sent, plus one
 *   trailing instruction, and it inherits the main request's call controls
 *   verbatim. The long shared prefix can then be served from the provider's
 *   prefix cache and only the instruction is billed at full price. A changed
 *   reasoning effort, temperature, or tool schema turns that into a miss, which
 *   is why none of them are re-decided here.
 * - **Degrade, never guess.** When that prefix cannot be reproduced (no logged
 *   request yet, no assistant tail, no route), it falls back to a clipped
 *   self-contained tail: cheap per token, always a cache miss, clearly reported
 *   as `mode: "tail"` so the caller can tell what it paid for.
 */

export const name = 'session-manual-title'

export const inject = ['connection', 'llm', 'sessions', 'webServer']

/** Same-origin endpoint the Client half posts to. */
const ENDPOINT = '/session-manual-title/run'

/** One request carries a session id and nothing else. */
const MAX_BODY_BYTES = 4 * 1024

/** Defensive cap on the accepted title before the service normalizes it. */
const MAX_TITLE_CHARS = 200

const DEFAULTS = {
  // The whole point of this plugin: build the auxiliary request on the main
  // request's exact prefix so the provider's prefix cache can serve it.
  sharePromptCache: true,
  // A ceiling against runaway output, not a length target: a reasoning model
  // that cannot switch off spends output budget thinking before it names
  // anything. The prompt, not this cap, keeps titles short.
  maxOutputTokens: 4096,
  timeoutMs: 45_000,
  // Non-CJK words / CJK characters the instruction asks for.
  targetWords: 6,
  targetCjkCharacters: 12,
  // How much of the conversation the self-contained fallback may read.
  tailMaxChars: 8_000,
}

/**
 * Register the rename endpoint.
 * @param ctx - context exposing connection, llm, sessions, and the web server.
 * @param config - optional cache, token, target, and transcript bounds.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: (request, response) => serve(ctx, options, request, response),
    }),
  )
}

function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const integer = (key, minimum, maximum) => {
    const value = source[key]
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : DEFAULTS[key]
  }
  return {
    sharePromptCache: source.sharePromptCache !== false,
    maxOutputTokens: integer('maxOutputTokens', 16, 8_192),
    timeoutMs: integer('timeoutMs', 1_000, 120_000),
    targetWords: integer('targetWords', 1, 20),
    targetCjkCharacters: integer('targetCjkCharacters', 1, 40),
    tailMaxChars: integer('tailMaxChars', 500, 40_000),
  }
}

async function serve(ctx, options, request, response) {
  try {
    // Renaming reads the owner's session and spends the owner's tokens.
    const admission = ctx.connection.admit(request)
    if ('rejection' in admission) {
      respond(response, admission.rejection === 401 ? 401 : 403, { ok: false, error: 'forbidden' })
      return
    }
    if (admission.peer.principal.kind !== 'owner') {
      respond(response, 403, { ok: false, error: 'forbidden' })
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      respond(response, 415, { ok: false, error: 'unsupported-media-type' })
      return
    }

    const body = await readJson(request)
    if (body === undefined) {
      respond(response, 400, { ok: false, error: 'bad-body' })
      return
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') {
      respond(response, 400, { ok: false, error: 'missing-session' })
      return
    }

    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      respond(response, 404, { ok: false, error: 'unknown-session' })
      return
    }
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) {
      respond(response, 500, { ok: false, error: 'no-title-service' })
      return
    }

    const plan = planRequest(ctx, session, options)
    if (plan === undefined) {
      respond(response, 422, { ok: false, error: 'no-conversation' })
      return
    }

    const text = await runCall(ctx, options, plan, request)
    const title = titleFromText(text)
    if (title === '') {
      respond(response, 502, { ok: false, error: 'empty-title' })
      return
    }

    // The official write path: the same one the built-in rename menu uses.
    // A user-sourced title pins the session, which is exactly what we want.
    const snapshot = titles.rename(session, title)
    respond(response, 200, {
      ok: true,
      title: snapshot.title,
      mode: plan.mode,
      provider: plan.route.provider,
      model: plan.route.model,
    })
  } catch (error) {
    respond(response, 500, {
      ok: false,
      error: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'internal',
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    })
  }
}

/**
 * Build the request parts, preferring the main request's exact prefix.
 * @returns plan, or undefined when the session has nothing to summarize.
 */
function planRequest(ctx, session, options) {
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const config = header?.config
  const loggedRoute =
    typeof config?.provider === 'string' && typeof config.model === 'string'
      ? { provider: config.provider, model: config.model }
      : undefined
  const fallbackRoute = defaultRoute(ctx)
  const route = loggedRoute ?? fallbackRoute
  if (route === undefined) return undefined

  if (options.sharePromptCache && loggedRoute !== undefined && typeof session.deriveMessages === 'function') {
    const history = session.deriveMessages()
    const tail = history[history.length - 1]
    // The main request always ends on the agent's reply. Anything else means
    // this is not the prefix the provider cached, so do not pretend it is.
    if (tail !== undefined && tail.role === 'assistant') {
      return {
        mode: 'shared',
        route,
        // Inherit the main request's controls verbatim: changing them can change
        // the provider-side request shape and turn the shared prefix into a miss.
        callConfig: {
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        },
        configureEffort: false,
        stream: {
          messages: [
            ...history,
            { role: 'user', content: [{ type: 'text', text: sharedInstruction(options) }] },
          ],
          ...(header.tools === undefined ? {} : { tools: header.tools }),
          ...(typeof session.toolHistory === 'function' ? { toolHistory: session.toolHistory() } : {}),
          ...(session.id === undefined ? {} : { sessionId: session.id }),
        },
      }
    }
  }

  const tail = clippedTail(session, options.tailMaxChars)
  if (tail === '') return undefined
  return {
    mode: 'tail',
    route,
    callConfig: {},
    configureEffort: true,
    stream: {
      messages: [{ role: 'user', content: [{ type: 'text', text: tail }] }],
      system: tailSystemPrompt(options),
    },
  }
}

function sharedInstruction(options) {
  return [
    'Now name this session, using everything above as its whole context.',
    `Reply with the title only, on one line, as plain text: about ${options.targetWords} words, or about ${options.targetCjkCharacters} characters when the title is in a CJK language.`,
    'Use the language the conversation is written in.',
    'No quotes, no markdown, no prefix such as "Title:", no explanation, no code.',
  ].join('\n')
}

function tailSystemPrompt(options) {
  return [
    'Create a concise title for the AI coding-assistant conversation you are given.',
    `Reply with the title only, on one line, as plain text: about ${options.targetWords} words, or about ${options.targetCjkCharacters} characters in a CJK language.`,
    'Use the language of the conversation.',
    'No quotes, no markdown, no prefix, no explanation, no code.',
    'If the conversation gives little to name, still return a short best-effort title.',
  ].join('\n')
}

/** Last resort input: the human text of the most recent turns, clipped. */
function clippedTail(session, maxChars) {
  if (typeof session.deriveMessages !== 'function') return ''
  const lines = []
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text !== '') lines.push(`${message.role}: ${text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length <= maxChars ? joined : `…${joined.slice(joined.length - maxChars)}`
}

function defaultRoute(ctx) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (typeof selection?.provider !== 'string' || typeof selection.model !== 'string') return undefined
  return { provider: selection.provider, model: selection.model }
}

/** Run the auxiliary call once and collect its text blocks. */
async function runCall(ctx, options, plan, request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const onClose = () => controller.abort()
  request.once('close', onClose)
  try {
    const call = await ctx.llm.prepareCall(
      {
        provider: plan.route.provider,
        model: plan.route.model,
        maxTokens: options.maxOutputTokens,
        ...plan.callConfig,
      },
      controller.signal,
      (controls, model) => {
        if (plan.configureEffort !== true) return controls
        // Only a declared level is trustworthy; an undeclared one is ignored
        // silently by some gateways, which would just make the UI lie.
        const effort = model.reasoning?.efforts?.[0]?.id
        return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
      },
    )
    let text = ''
    for await (const chunk of call.stream({ ...call.config, ...plan.stream, signal: controller.signal })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && (chunk.reason.kind === 'max-tokens' || chunk.reason.kind === 'tool-calls')) {
        throw new Error(`title output rejected: ${chunk.reason.kind}`)
      }
    }
    return text
  } finally {
    clearTimeout(timer)
    request.off('close', onClose)
  }
}

const EMPHASIS = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u
const QUOTES = /^["'“”‘’「」『』`]+|["'“”‘’「」『』`]+$/gu

/** First non-empty line, without emphasis or quote wrappers. */
function titleFromText(text) {
  const line = text
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (line === undefined) return ''
  const groups = EMPHASIS.exec(line)?.groups
  const withoutEmphasis =
    groups === undefined || groups.inner.includes(groups.marker) ? line : groups.inner
  return withoutEmphasis
    .replace(/^\s*(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(QUOTES, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
}

async function readJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function respond(response, status, payload) {
  if (response.headersSent === true) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Test seam for the output parser; not a runtime surface. */
export const __testing = { titleFromText, clippedTail }

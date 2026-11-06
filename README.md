# dsh-session-manual-title

Rename a session with AI — [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.

One menu row and one header chip: click, and a single model call reads the whole
conversation and writes a title through the official rename path. It runs **only
when you click** — no provider, nothing per message — and it builds the auxiliary
request on the main request's exact prefix, so the provider's prompt cache serves
the expensive part.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Why not one of the existing title plugins?

Several community plugins rename sessions, but none of them reuse the main
request's prefix cache: they assemble their own transcript (usually clipped to a
few KiB) or reimplement the native rename dialog, so their auxiliary request
shares nothing with the cached prefix and every input token is billed as a miss.

| | this plugin |
|---|---|
| Trigger | manual only (menu row / header chip) |
| Input | the main request's exact prefix — tools, full history, inherited call controls |
| Cost | the long prefix is a cache hit; only the trailing instruction is new |
| Write path | `sessionTitle.rename()`, the same one the official menu uses |
| Provider | registers none, so the shipped automatic titling is untouched |

## Entries

| Entry | Slot |
|---|---|
| "Rename with AI" in the session `…` menu | `sidebar.workspaces.session.menu.item`, `order: 250` — right below the shipped Rename |
| "Rename with AI" chip in the session header | `conversation.session.header.actions`, `order: -8` |

Clicking one runs a single call, then renames. Success and failure both surface as
a toast. A user-sourced title pins the session, so automatic titling will not
overwrite it afterwards.

## How the cache is reused

The auxiliary request is:

```js
const header  = session.requestHeader()   // config (provider/model/effort/temperature) + tools
const history = session.deriveMessages()  // exactly what the model last saw
messages: [...history, { role: 'user', content: [{ type: 'text', text: instruction }] }]
tools: header.tools, toolHistory: session.toolHistory(), sessionId: session.id
callConfig: the main request's reasoningEffort and temperature, unchanged
```

Cache matching is prefix-based, so the history hits and only the instruction is
new. Four things break that prefix, and the code avoids all four: the history must
end on the agent's reply, the call controls must be inherited verbatim, the tool
schema must come from `header.tools`, and no request may precede the logged one.
When the prefix cannot be reproduced the plugin degrades to a clipped
self-contained tail and reports `mode: "tail"` instead of pretending.

## Configuration (`cordis.patch.yml`)

| Field | Default | Meaning |
|---|---|---|
| `sharePromptCache` | `true` | Build on the main request's prefix. Off = always the clipped tail |
| `maxOutputTokens` | `4096` | Output ceiling, not a length target (reasoning models spend budget thinking) |
| `timeoutMs` | `45000` | Per-call timeout |
| `targetWords` / `targetCjkCharacters` | `6` / `12` | Length the prompt asks for |
| `tailMaxChars` | `8000` | How much of the conversation the tail fallback reads |

## Limitations

- **Live sessions only.** `ctx.sessions.get()` cannot reach a session that is not
  loaded, so those answer `unknown-session`.
- **The shared prefix is a trade.** Input ≈ the whole conversation in tokens; it is
  cheap per token once cached, but one click on a very long session still costs
  more than the tail mode. Turn `sharePromptCache` off there.
- **Anything that changes the call controls is a miss**, which is why the plugin
  deliberately offers no override for them.
- **Upstream coupling.** It relies on `requestHeader()` / `deriveMessages()` /
  `toolHistory()` / `llm.prepareCall`; a signature change needs a new release.

## Development

```sh
npm test          # node --test: route, prefix reuse, tail fallback, auth, parser
node --check index.js && node --check client.js
```

Install into a profile from a checkout:

```text
plugin_manager install_bundle  target = <absolute path to this directory>
```

The Host half is an in-process module, so **restart dsh** after installing; the
Client half only needs a page refresh.

## License

MIT

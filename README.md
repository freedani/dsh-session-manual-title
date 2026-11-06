# dsh-session-manual-title

点一次，让模型通读**整个会话**给一个标题，并复用主请求的 prefix cache。不点不跑。

## 为什么不是装现成的

社区里做「会话改名」的插件不少（`dsh-session-titler`、`dsh-ai-session-title`、`dsh-auto-rename`），
但**没有一个复用主会话的 prefix cache**：它们要么自己拼一段 32 KiB transcript，要么复刻一个弹窗，
辅助请求和主请求前缀不同，输入 token 全部按 miss 计费。

这个插件只做一件事，但把这件事做对：

- **按需**：不注册 `sessionTitle` provider（那是独占的、由服务按每条消息驱动），所以不点不花 token，
  也不影响已经装着的自动标题 provider。
- **复用缓存**：辅助请求 = 主请求的精确前缀（`session.requestHeader()` 的 tools + `deriveMessages()`
  的全量历史 + 原样继承的 `reasoningEffort` / `temperature`）+ 末尾一条「给它起个标题」的指令。
  前面的历史命中 provider 的 prefix cache，只有那条指令是全价。
- **会退化**：前缀复现不了（会话还没发过请求、历史不是 assistant 结尾、拿不到路由）时退回
  「截断尾部」的自包含请求，便宜但必然 miss，并在响应里标 `mode: "tail"`。

## 入口

| 入口 | 位置 |
|---|---|
| 会话「…」菜单「AI 重命名」 | `sidebar.workspaces.session.menu.item`，`order: 250`，紧跟官方「重命名」 |
| 会话标题栏「✦ AI 重命名」 | `conversation.session.header.actions`，`order: -8` |

点下去：一次模型调用 → 走 `ctx.sessionTitle.rename()`（和官方改名同一条写入路径）→ 侧边栏标题立刻更新。
命名中按钮显示「命名中…」，成功/失败在底部弹一条 toast。

> 用户来源的标题会把会话 **pin** 住，之后自动标题 provider 不再改它 —— 这正是"手动改名不被覆盖"的机制。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `sharePromptCache` | `true` | 复用主请求前缀。关掉就退回 tail 模式 |
| `maxOutputTokens` | `4096` | 输出上限，不是长度目标（推理模型会先花预算思考） |
| `timeoutMs` | `45000` | 单次调用超时 |
| `targetWords` / `targetCjkCharacters` | `6` / `12` | 写进提示词的标题长度目标 |
| `tailMaxChars` | `8000` | tail 模式最多读多少字符 |

## 已知限制

- **只对活着的会话有效**：`ctx.sessions.get(sessionId)` 取不到未加载的会话，此时返回 `unknown-session`。
- **共享前缀是把双刃剑**：输入 ≈ 整个会话 token 数（命中后便宜一个数量级），长会话一次点击的
  绝对成本仍高于 tail 模式；超长会话（>200K）建议关掉 `sharePromptCache`。
- **改 call controls 就是 miss**：`reasoningEffort` / `temperature` / tools schema 任何一项与主请求
  不同，缓存就失效。这里刻意不提供这些覆盖项。
- **上游改版风险**：依赖 `session.requestHeader()` / `deriveMessages()` / `toolHistory()` 的行为，
  以及 `ctx.llm.prepareCall` 的签名。

## 开发

```sh
node --check index.js && node --check client.js
plugin_manager install_bundle  target = /Users/netease/Code/dsh-plugins/packages/dsh-session-manual-title
```

Host 半边是进程内模块，装完**要重启**一次应用；Client 半边刷新页面即可。

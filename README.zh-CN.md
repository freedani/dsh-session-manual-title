# dsh-session-manual-title

按需给会话改名，DeepSeek Harness 插件。

会话行「…」菜单和标题栏各一个入口：点一下，模型通读整个会话，走官方改名路径写回标题。
它**只在点击时运行**——不注册 provider、不按消息烧 token——并且把辅助请求建在主请求的
精确前缀上，让 provider 的 prompt cache 承担昂贵的那一段。

## 为什么不用现成的

社区里做会话改名的插件不少，但**没有一个复用主请求的 prefix cache**：它们要么自己拼一段
（通常还截断到几 KiB）的 transcript，要么复刻原生改名弹窗，辅助请求和缓存前缀毫无关系，
输入 token 全部按 miss 计费。

| | 本插件 |
|---|---|
| 触发 | 只手动（菜单项 / 顶栏 chip） |
| 输入 | 主请求的精确前缀 —— tools、全量历史、原样继承的 call controls |
| 成本 | 长前缀命中缓存，只有末尾那条指令是新 token |
| 写入 | `sessionTitle.rename()`，与官方「重命名」同一条路径 |
| provider | 一个都不注册，已装的自动标题不受影响 |

## 入口

| 入口 | 槽位 |
|---|---|
| 会话「…」菜单「AI 重命名」 | `sidebar.workspaces.session.menu.item`，`order: 250`，紧跟官方「重命名」 |
| 会话标题栏「AI 重命名」chip | `conversation.session.header.actions`，`order: -8` |

点下去：一次模型调用 → 改名。成功/失败都有 toast。用户来源的标题会把会话 **pin** 住，
之后自动标题不会再覆盖它。

## cache 是怎么复用的

辅助请求就是：

```js
const header  = session.requestHeader()   // config(provider/model/effort/temperature) + tools
const history = session.deriveMessages()  // 模型上次真正看到的消息
messages: [...history, { role: 'user', content: [{ type: 'text', text: 指令 }] }]
tools: header.tools, toolHistory: session.toolHistory(), sessionId: session.id
callConfig: 主请求的 reasoningEffort 与 temperature，原样不动
```

缓存按前缀匹配，所以历史全部命中，只有那条指令是全价。会破坏前缀的四件事，代码都躲开了：
历史必须以 assistant 结尾、call controls 必须原样继承、tools 必须来自 `header.tools`、
且不能在主请求被记录之前发。前缀复现不了时退回截断尾部的自包含请求，并在响应里标
`mode: "tail"`，不假装命中了。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `sharePromptCache` | `true` | 复用主请求前缀；关掉就永远走 tail |
| `maxOutputTokens` | `4096` | 输出上限，不是长度目标（推理模型会先花预算思考） |
| `timeoutMs` | `45000` | 单次调用超时 |
| `targetWords` / `targetCjkCharacters` | `6` / `12` | 提示词里要求的长度 |
| `tailMaxChars` | `8000` | tail 模式最多读多少字符 |

## 已知限制

- **只对活着的会话有效**：`ctx.sessions.get()` 取不到未加载的会话，返回 `unknown-session`。
- **共享前缀是取舍**：输入 ≈ 整个会话 token，命中后单价很便宜，但超长会话点一次的绝对成本
  仍高于 tail 模式，那种会话把 `sharePromptCache` 关掉。
- **改 call controls 就是 miss**，所以本插件刻意不提供这几项的覆盖。
- **依赖上游行为**：`requestHeader()` / `deriveMessages()` / `toolHistory()` / `llm.prepareCall`，
  签名一变就得跟版本。

## 开发

```sh
npm test          # node --test：路由、前缀复用、tail 回退、鉴权、解析器
node --check index.js && node --check client.js
```

从 checkout 装进 profile：

```text
plugin_manager install_bundle  target = <本目录的绝对路径>
```

Host 半边是进程内模块，装完**要重启 dsh**；Client 半边刷新页面即可。

## License

MIT

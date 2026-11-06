# 发布与分发

写给这个仓库的维护者（也就是你自己）：**怎么发出去**、**发之前必须检查什么**。

---

## 三条路，先想清楚给谁用

| 路径 | 需要 npm 账号？ | 适合 | 用户怎么装 |
|---|---|---|---|
| 本地目录 | 否 | 只有自己用 | `plugin_manager install_bundle` + 本目录绝对路径 |
| GitHub 仓库 | 否 | 自己用 + 别人能看源码 | `dsh plugin add github:<owner>/<repo>` |
| npm 包 | 是 | 社区市场收录 | `dsh plugin add dsh-session-manual-title` |

本机默认 npm registry 是公司私服，**发公共 npm 必须显式切源**，见下面「发 npm」。

---

## 发之前必须过的检查

```sh
npm test                          # 6 个用例：路由 / 前缀复用 / tail 回退 / 鉴权 / 解析器
node --check index.js
node --check client.js
npm pack --dry-run                # 看真正会被发出去的文件列表
```

`npm pack --dry-run` 要能看到：`index.js`、`client.js`、`cordis.patch.yml`、
`locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`LICENSE`、`CHANGELOG.md`。
`node_modules/`、`test/` 不该出现（`test/` 只给仓库，不进包）。

---

## 发 npm

```sh
npm publish --registry=https://registry.npmjs.org --access public
```

发之前确认三件事：

1. `package.json` 的 `version` 已经加过，`CHANGELOG.md` 里对应版本有条目；
2. `publishConfig.access` 是 `public`（否则默认走私有）；
3. `dsh.bundle.patch` 和 `dsh.client` 都在 —— 少了 `dsh.bundle` 就装不成 bundle，
   少了 `dsh.client` 前端两个入口不会出现。

**版本号门槛**：`engines.dsh` 写的是 `>=0.2.1-rc.3 <0.3.0-0`。预览版之间接口可能有变，
如果只是改文案就发 patch，动了 `requestHeader()` / `llm.prepareCall` 这些调用点就发 minor，
并把新版本要求写进 `engines.dsh`。

---

## 从 GitHub 装（不发布也能用）

用户侧：

```sh
dsh plugin add github:freedani/dsh-session-manual-title
```

要求仓库根就是这个包（`package.json` 带 `dsh.bundle`），本仓库满足。

---

## 装完为什么没反应

- **Host 半边是进程内模块** → 必须重启 dsh / 桌面应用，刷新页面不够。
- **Client 半边**（两个入口 + toast）→ 刷新页面即可。
- 点菜单项报 `forbidden` → 那条请求没通过 `ctx.connection.admit()`（不是 owner peer）。
- 报 `unknown-session` → 会话没在运行实例里（未加载的会话不能改名）。
- 报 `no-conversation` → 会话里还没有可总结的内容。

---

## 回归时容易忽略的点

- `x-session-manual-title` 端点路径、`__ModuleLoader__.load({ id })`、locale 命名空间、
  `package.json` 的 `name`、patch 行 id —— 这五处必须一致，**改包名时一起改**，漏一个就加载不了。
- 菜单项图标必须走 16×16 SVG + `stroke-width: 0.8`：官方那排是描边图标，实心字或粗笔画一眼就看出来。
- 行内边距 `padding-left: 7px` / `gap: 4px` 是按官方行量出来的，不是随手写的，
  改了会和官方那几行错位。

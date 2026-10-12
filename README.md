# dsh-sound-player — DSH 音效播放器

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **官方桌面端**开发的**音效播放器**插件：
在对话的各个阶段（对话完成、请求权限、被提问、子代理跑完……）发出提示音，提醒你去处理。
所有操作都集成在**设置菜单**里（设置 → 音效播放器），**没有悬浮窗、没有第二个入口**。

> ⚠️ **支持范围**：本插件**只维护官方 DSH 桌面端**。**Web 端与第三方打包端不再更新**，
> 在这些端套用本插件可能出现意料之外的状况，请自行评估。
> 宿主端与客户端接口都对齐官方桌面端内置的插件契约（`ctx.sessions` / `ctx.remote` /
> `settings.section` 槽位），不为其他宿主做兼容。

## 更新日志

### 0.3.0

- 适配官方 DSH。
- 调整音效库管理模式。
- 增添多个私人音效供选取。
- 增添音效截断、渐弱退出功能，现在可以播放固定歌曲中的某一个特殊段落了（不用自己截断音乐）。

## 功能

### 设置页（设置 → 音效播放器）

- 总开关（**只有总开关**：没有全局音量，也没有「仅当前会话响铃」）；
- 7 类内置情况各自绑定音效并开关，显示形如 `【√】发送消息时播放【提示音1】`；
- **级联式音效选择器**：下拉里是三个音效库，鼠标悬停文件夹即在右侧展开内容，
  子文件夹继续向右展开（支持任意层级）；选择器只显示音效名、不铺路径文字，
  名称 / 选择器 / 按钮按固定列宽纵向对齐；
- **悬停只用于展开菜单，不会发出任何声音** —— 试听一律由下面【设置】面板里的按钮触发；
- **每条绑定都有一个【设置】面板**（点开后在行下方展开）：
  - **音量滑块**：逐条独立，互不影响（对话完成可以响亮、子代理完成可以很轻）；
  - **播放区间**「起点 —— 终点」：毫秒、精确到 1 ms，默认全播放。
    导入的长音频/整首歌可以只播其中一段，不用自己先剪辑；
  - **特效**：目前提供「渐弱消失」；
  - **【试听】**：按这条的音量 / 区间 / 特效播放；**播放中会变成红色方形停止键**，
    再点即中止 —— 导入整首歌也不会被迫放完；
- **导入音效 / 导入文件夹 / 拖放**：一律写入「自定义音效库」，文件夹导入保留子目录结构，
  重名自动加 `-2` 后缀；导入区只显示各库条目数，读不到库时会给出原因并提供「重试」；
- **打开音效库**：在文件管理器里打开库目录，可直接改名、加子文件夹、删文件。

### 三个音效库（都是插件包内的真实文件夹，随包分发）

| 库 | 内容 |
| --- | --- |
| `默认音效库` | 内置**合成音效 8 个**（`合成音效/*.json` 是 Web Audio 配方，免费无版权、可手改音符参数）＋ **Windows 系统提示音 3 个**（`Windows 系统提示音/*.wav`） |
| `神人音效库` | **34 个内置 meme / 游戏音效**，已按中文社区通用叫法重命名（原始文件名、出处与置信度见 [`sounds/神人音效库/命名对照.md`](sounds/神人音效库/命名对照.md)） |
| `自定义音效库` | 你导入的音效（本机数据，不入 git；目录缺失时自动创建） |

内置两库不可删（自定义库的条目可在选择器里悬停删除）。默认 7 种情况仍绑定原来的内置音效，开箱即用。

### 内置情况

- 对话完成提示（`turn-end`）
- 发送消息时提示（你发送消息，`user-message`）
- 权限请求时提示（`approval-requested`）
- 被提问时提示（AI 弹 `ask_user_question`，`question-requested`）
- 服务终止时提示（连接断开，`stream-end`）
- **子代理运行完成**（`subagent-complete`）：任意子代理的 `running` 由真变假。
  注意 **Agent Teams 的队友是可续跑（continuable）的子代理**，所以这条的含义是
  「某个子代理结束了一轮」——队友随时可被唤醒继续干活，不等于任务彻底做完；
- **最后一个子代理运行完成**（`last-subagent-complete`）：**所有会话**中运行中的子代理数量
  从 ≥1 归零。队友全部暂时空闲（例如 Lead 正在思考/等待）时也会触发。

## 安装

要求已安装 `dsh` CLI（`dsh --help` 存在）。

### 从 GitHub 安装（推荐）

```sh
dsh plugin add github:LaoQianwocao/dsh-sound-player
```

第一次安装若 pnpm 提示需要允许构建脚本，把打印出的包 `key` 填入
profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，然后重跑 `add`。

### 从本地 tarball 安装

```sh
pnpm pack
dsh plugin add ./dsh-sound-player-0.3.0.tgz
```

### 手动注册（无 bundle 时的兜底）

在 profile 的 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: sound-player
      name: dsh-sound-player
```

之后无需改动任何官方文件，**重启 DSH 桌面端**并刷新页面，即可在设置菜单看到「音效播放器」。

## 触发方式（trigger）取值

| trigger | 含义 |
| --- | --- |
| `turn-end` | 对话完成（AI 结束一轮回答） |
| `user-message` | 发送消息时 |
| `approval-requested` | 权限请求时 |
| `question-requested` | 被提问时 |
| `stream-end` | 服务终止时 |
| `subagent-complete` | 子代理运行完成 |
| `last-subagent-complete` | 最后一个子代理运行完成 |
| `manual` | 手动触发（由插件调用 `triggerSituation(id)`） |

插件可通过 `addSituation` 注册自己的情况，并用 `triggerSituation(id)` 触发；把
自定义 trigger 值传给 `addSituation` 后，需由插件自己在合适的时机调用
`triggerSituation(id)` 播放（框架只识别上面列出的内置 trigger 事件）。

## 插件 API（供其他插件调用）

通过 `ctx.get("soundPlayer")` 或 `window.__dshSoundPlayer__` 使用：

- 导入音频：`importAudioFile(file)` / `importAudioFiles(files)` / `importAudioDir(files)`（一律写入自定义音效库）
- 音效库：`getLibraryTree()` / `refreshLibrary()` / `openLibrary(path?)` / `listSounds()` / `listSoundsMeta()` / `deleteSound(path)`（仅自定义库）
- 试听：`previewSituation(id)`（带该条的音量 / 区间 / 特效，返回可 `stop()` 的声部句柄）/ `stopPreview()` / `getSoundInfo(path)`（取时长，毫秒）/ `previewSound(path)`（整条试听某个库内音效）
- 增添情况：`addSituation({ label, trigger, audioId?, enabled?, volume? })` → 返回 id
- 触发情况并播放音效：`triggerSituation(id)` / `trigger(id)`
- 修改情况：`setSituation(id, patch)`、`setSituationEnabled(id, b)`、`setSituationAudio(id, audioId)`、`setSituationVolume(id, v)`、`removeSituation(id)`
- 其他：`listSituations()` / `getState()` / `setEnabled` / `setVolume`（兼容入口，批量写入所有情况，非全局音量）/ `subscribe(fn)` / `stopAll()`

注意：`audioId` / `path` 是**库内相对路径**（例如 `神人音效库/哈基米.mp3`），
不再是旧版的内置 id（老配置会自动迁移）。

## 注意事项

- 自动播放策略（桌面端渲染进程沿用 Chromium 策略）：需要界面有过一次鼠标/键盘交互后
  音效才会出声，插件会在首次交互时自动恢复 AudioContext。
- **音效库就是插件目录里的真实文件**：绑定下拉里浏览 `sounds/` 下的三个库；改名、加子文件夹、
  增删文件直接用文件管理器操作（设置页「打开音效库」一键打开）。音频用 MP3 / WAV / OGG 等常见格式即可；
  `默认音效库/合成音效/*.json` 是 Web Audio 配方，手改里面的音符参数就能自定义合成音。
- **导入的音效落到 `sounds/自定义音效库/`**，导入文件夹会保留子目录结构；重名自动加 `-2` 后缀。
  该目录已 gitignore —— 它属于本机数据，不会被推到仓库。
- 音量、播放区间、特效都是**逐条绑定**的属性，随情况一起存在 localStorage 里；播放时只读这条自身的设置，
  没有任何全局音量参与。
- **同一个音效同一时刻只保留一路发声**：再次触发会先掐掉上一路。所以把两条情况绑到同一个音效时
  不会叠成「多重音效」；想要叠加效果就给它们绑不同的音效。
- 「服务终止」在连接代际消失（`generation` → `undefined`）或连接状态进入 `disconnected` 时播放一次，
  带 5 秒防抖，避免重连抖动重复响。
- 不再按会话过滤：插件已取消「仅当前会话响铃」，后台会话与其它会话触发的情况同样会响铃。
  实时事件仍来自**当前会话**的事件窗口，子代理检测则覆盖全部会话。
- `test/event-chain.cjs` 与 `test/library-host.cjs` 是无头自检。桌面端升级后建议重跑一遍，
  确认插件依赖的运行时契约没有变化。

## 实现说明（开发向）

<details>
<summary>点开查看：宿主端点挂载方式、自检文件、内部契约与踩过的坑</summary>

**宿主端点必须用精确 Fetch 路由注册**

```js
ctx.connection.fetch.register({
  path: "/api/soundPlayer/<name>",   // tree / read / import / delete / open / status
  methods: ["POST"],
  requestBody: "buffered",
  fetch: (request) => Promise<Response>,
});
```

共享通道 `/api` 的分发顺序是「精确 Fetch 路由 → 该通道**唯一**的拦截器 → 404」，而
`ctx.connection.rpc.intercept("/api", …)` 是**单槽位**（已存在时直接抛错）：插件一旦抢到那个槽位，
就会顶掉网关自己的分发，**所有生成式 Remote（含桌面端启动时 welcome 读 settings）都会 404，
足以让应用打不开**。精确路由是附加式、分发时优先级更高、不影响任何其它端点。
`test/library-host.cjs` 里对 `rpc.intercept` / `rpc.handle` 设了「一碰就报错」的回归护栏。

请求/响应与生成式 Remote 同形，所以客户端直接用 `connection.rpc.call` 即可：

```
请求  POST /api/soundPlayer/tree
      { type: "client-request", rpcId, method: "soundPlayer/tree", payload }
响应  { type: "server-response", rpcId, result: { ok: true, value } }
```

音频字节以 base64 放在 `value` 里：客户端一元 RPC 的结果类型只声明了 `{ ok, value }`，
没有暴露 attachments，因此不依赖附件通道。

**宿主半段改动必须重启桌面端才会生效**（只刷新页面不够）。宿主端 `inject` 声明了 `connection` 依赖；
服务尚未就绪时会按 500ms 重试（最多 30 秒），每次尝试都写进 `sounds/.host-status.json`
（库根目录、`hasConnection` / `hasFetchRegister` / `registeredRoutes` / 尝试次数 / connection 服务成员）。
**读这个文件就能判断宿主加载的是不是新代码、卡在哪一步**；它由运行中的应用写入，测试跑完会自行删除。

**触发信号来源**（与当前 DSH 客户端运行时对齐，只订阅客户端插件契约，不依赖私有构建产物）：

| trigger | 信号来源 |
| --- | --- |
| `turn-end` / `user-message` / `approval-requested` | 当前会话的实时事件窗口 `sessions.binding(id).eventSource`：只处理 `append` 增量，订阅前用窗口最大 `seq` 建基线，避免回放历史事件响铃 |
| `question-requested` | 宿主转发事件 `ctx.remote.$on("user-questions/request")`（waterfall 事件，插件只旁听并 `return next()` 把请求交还应答链）；会话事件 `tool/call` 且 `name === "ask_user_question"` 作为兜底。两条路径共用 1.5 秒去重，同一次提问只响一声 |
| `stream-end` | `connection.generation` 变为 `undefined`，或 `connection.state` 进入 `disconnected`；两条信号共用 5 秒防抖 |
| `subagent-complete` / `last-subagent-complete` | `sessions.list` 快照中 `origin === "subagent"` 行的 `running` 翻转；**所有会话**（含后台会话）中运行中的子代理数量从 ≥1 降到 0 时触发「最后一个」 |

「当前会话」的判定：`sessions.list` 快照形如 `{ byId, phase }`，**没有 `current` 字段**；
当前会话是 `retainedBy.mainView > 0` 的那一行（DSH 客户端自身的约定）。它只用来决定
**订阅哪个会话的实时事件窗口**，不再用于过滤。

**抗重复播报**（两层防御）：① 页面级单实例收编——插件重新挂载（热更新 / 连接代际重挂）时
先收掉上一份运行时，避免旧 watcher 继续订阅事件窗口；② 对 `(会话, seq)` 做全页幂等，
同一个事件即使被重复投递也只响一次。

**配置迁移**（老配置无需手动处理）：

- v2 → v3：全局音量写进每条情况作为初值，随后丢弃全局字段（升级后响度不变）
- v3 → v4：丢弃「仅当前会话响铃」
- v4 → v5：内置 id 换成库内路径；旧版存在浏览器 IndexedDB 里的导入音效首次启动搬到「自定义音效库」（只做一次）
- v5 → v6：为每条补上 `clipStart` / `clipEnd` / `effect` 默认值（起点 0、终点空、无特效），播放范围不变

`sessions.list` 与 `connection.generation` 属于客户端运行时的内部快照存储，未出现在官方客户端服务契约
（cordis-inspect 目录）里。插件对它们的读取都做了判空与 `try/catch`：接口缺失时静默降级，不影响其他功能。
`origin === "subagent"` 与 `running` 这两个字段本身是官方客户端 UI 在用的（`useSessions` 的
`byId[id]?.origin === "subagent"`、`runningChildCount()` 里的 `byId[child.id]?.running`），
所以子代理识别与运行状态的口径与官方界面一致。

**与官方「完成未读」口径的差异（有意为之）**：官方 `uiSession` 服务的 `sessionStatus` 只在
「会话不在主视图」时才记一次完成未读 —— `observeRunning()` 里是
`else if (… && !this.isMain(sessionId)) this.completionUnread.add(sessionId)`，
且它跟踪**所有**会话。本插件按要求**不做会话过滤**：任何会话（含你正在看的那个）里子代理的
`running` 翻转都会响，且只对 `origin === "subagent"` 的行响。
（`uiSession` 未出现在 cordis-inspect 的客户端服务目录里，插件无法确认能否取到它，
因此仍用公开可读的列表行 —— 也就是官方代码里的兜底路径。）

</details>

## 结构

- `package.json` — 声明 `dsh.client`（`platform: "web"`，桌面端加载的就是这套客户端 bundle，不是分发渠道）与 `dsh.bundle`（自注册行）
- `cordis.patch.yml` — 注册本插件的宿主端行（plugin row）
- `lib/index.js` — 宿主端：音效库的读取 / 导入 / 删除 / 打开 / 自检端点，注册为 `/api/soundPlayer/*` 精确路由
- `client.js` — 客户端全部功能（音效库消费 / 音效引擎 / 事件监听 / API / 设置页 UI），随桌面端渲染进程运行；无悬浮窗
- `sounds/默认音效库/` — 内置合成音效（`合成音效/*.json`）与 Windows 提示音（`Windows 系统提示音/*.wav`）
- `sounds/神人音效库/` — 34 个内置 meme / 游戏音效（`命名对照.md` 记录原名与出处）
- `sounds/自定义音效库/` — 使用者导入的音效（本机数据，已 gitignore）
- `test/library-host.cjs` — 宿主端无头测试：目录树 / 读取 / 导入去冲突 / 路径越界 / 删除限制 / 协议细节 / 安全护栏
- `test/event-chain.cjs` — 客户端无头自检：把真实宿主路由当 RPC 传输层接上，断言 7 类触发、逐条音量、
  截断与渐弱、抗重复、级联选择器与【设置】面板结构

## 测试

```sh
node test/library-host.cjs        # 宿主端端点
node test/event-chain.cjs client.js   # 客户端（含真实宿主路由联测）
```

## 在 dshfind.com 上被发现

本仓库打上 GitHub topic：`dsh-plugin`（在仓库 Settings → Topics 添加），即可被
[dshfind.com](https://dshfind.com) 收录 —— 它索引 topic 为 `dsh-plugin` 的公开仓库。

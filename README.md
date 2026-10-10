# dsh-sound-player — DSH 桌面端音效播放器

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **桌面端**开发的**音效播放器**插件：
所有操作都集成在**设置菜单**中（设置 → 音效播放器），**没有悬浮窗、没有第二个入口**。
发布为 DSH 客户端插件（`dsh.client`），支持 GitHub / npm / tarball 分发。

> 本插件是「音效播放器」，在用户进行对话时，可以在各种阶段（对话终止，请求权限，子代理完成等）发出提示音，提醒用户处理相应状况。
>
> **维护范围**：只针对**正版 DSH 桌面端**更新，对接桌面端内置的客户端插件契约
> （`ctx.sessions` / `ctx.remote` / `settings.section` 槽位），不为其他宿主或旧版网页端做兼容。

## 功能

1. **设置页音效播放器**（设置 → 音效播放器）
   - 总开关（**只有总开关**：没有全局音量，也没有「仅当前会话响铃」）；
   - 为每种「情况」绑定音效并开关，显示格式如 `【√】发送消息时播放【提示音1】`；
   - **级联式音效选择器**：下拉里是三个音效库，鼠标悬停文件夹即在右侧展开内容，
     子文件夹继续向右展开（支持任意层级）；选择器只显示音效名、不铺路径文字，
     名称 / 选择器 / 按钮按固定列宽纵向对齐；
   - **每条绑定都有一个【设置】面板**（点开后在行下方展开）：音量滑块、
     播放区间「起点 —— 终点」（毫秒，精确到 ms，默认全播放；导入的长音频可以只播其中一小段）、
     特效（目前提供「渐弱消失」）、以及【试听】；
   - **【试听】在播放中会变成红色方形停止键**，再点一下即中止——导入整首歌也不会被迫放完；
     试听按该条绑定的音量 / 区间 / 特效播放，但不受总开关与单条开关影响；
   - 导入音频：导入音效 / 导入文件夹（写入「自定义音效库」，文件夹导入保留子目录结构），
     也可把音频拖到设置页；导入区只显示各库数量，读不到库时会给出原因并提供「重试」；
   - **打开音效库**：在文件管理器里打开库目录，可直接改名、加子文件夹、删文件。

2. **三个音效库（都是插件包内的真实文件夹，随包分发）**
   - `默认音效库` — 内置合成音效（8 个 `*.json` Web Audio 配方）+ Windows 系统提示音（3 个 `*.wav`）；
   - `神人音效库` — 34 个内置 meme / 游戏音效，已按中文社区通用叫法重命名
     （原始文件名、出处与置信度见 [`sounds/神人音效库/命名对照.md`](sounds/神人音效库/命名对照.md)）；
   - `自定义音效库` — 使用者导入的音效（本机数据，不入 git）；
   - 三个库都由宿主端（`lib/index.js`）读取，客户端经已认证的 RPC 通道取字节并按需解码缓存；
     内置两库不可删，自定义库可在选择器里直接删。
   - 默认的 7 种情况仍绑定原来的内置音效，开箱即用。
   - ⚠️ **宿主半段（`lib/index.js`）改动必须重启 DSH 桌面端才会生效**，只刷新页面不够。
     宿主端 `inject` 声明了 `connection` 依赖（否则 apply 可能早于服务就绪、拿不到 `rpc`），
     拿不到服务时会按 500ms 重试（最多 30 秒），每次尝试的结果都写进
     `sounds/.host-status.json`（库根目录、`hasConnection` / `hasRpc` / `registeredIntercept`、
     尝试次数、connection 服务成员）。**读这个文件就能判断宿主加载的是不是新代码、卡在哪一步**；
     它由运行中的应用写入，测试跑完会自行删除。
   - 客户端与宿主的调用形态：浏览器把 `channel/endpoint` 拼成 HTTP 路径 POST
     （`api/soundPlayer/tree`），因此只有 `/api` 可达，endpoint 必须带 `soundPlayer/` 前缀；
     宿主用 `ctx.connection.rpc.intercept("/api", ep => ep.startsWith("soundPlayer/"), …)` 接入同一条链路。

3. **内置情况**
   - 对话完成提示（`turn-end`）
   - 发送消息时提示（你发送消息，`user-message`）
   - 权限请求时提示（`approval-requested`）
   - 被提问时提示（AI 弹 `ask_user_question`，`question-requested`）
   - 服务终止时提示（连接断开，`stream-end`）
   - **子代理运行完成**（`subagent-complete`，任意子代理跑完）
   - **最后一个子代理运行完成**（`last-subagent-complete`，所有会话中运行中的子代理全部完成）

4. **供其他插件使用的 API**（`ctx.get("soundPlayer")` 或 `window.__dshSoundPlayer__`）
   - 导入音频：`importAudioFile(file)` / `importAudioFiles(files)` / `importAudioDir(files)`（一律写入自定义音效库）
   - 音效库：`getLibraryTree()` / `refreshLibrary()` / `openLibrary(path?)` / `listSounds()` / `listSoundsMeta()` / `previewSound(path)` / `deleteSound(path)`（仅自定义库）
   - 试听（带该条的音量 / 区间 / 特效）：`previewSituation(id)` → 返回可 `stop()` 的声部句柄 / `stopPreview()` / `getSoundInfo(path)`（取时长，毫秒）
   - 增添情况：`addSituation({ label, trigger, audioId?, enabled?, volume? })` → 返回 id
   - 触发情况并播放音效：`triggerSituation(id)` / `trigger(id)`
   - 修改情况：`setSituation(id, patch)`、`setSituationEnabled(id, b)`、`setSituationAudio(id, audioId)`、`setSituationVolume(id, v)`、`removeSituation(id)`
   - 其他：`listSituations()` / `getState()` / `setEnabled` / `setVolume`（兼容入口，批量写入所有情况，非全局音量）/ `subscribe(fn)` / `stopAll()`
   - 注意：`audioId` / `path` 现在是**库内相对路径**（例如 `神人音效库/哈基米.mp3`），
     不再是 v4 及以前的内置 id（老配置会自动迁移）。

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

## 触发信号来源（与当前 DSH 客户端运行时对齐）

插件只订阅客户端插件契约，不依赖私有构建产物：

| trigger | 信号来源 |
| --- | --- |
| `turn-end` / `user-message` / `approval-requested` | 当前会话的实时事件窗口 `sessions.binding(id).eventSource`：只处理 `append` 增量，订阅前用窗口最大 `seq` 建基线，避免回放历史事件响铃 |
| `question-requested` | 宿主转发事件 `ctx.remote.$on("user-questions/request")`（waterfall 事件，插件只旁听并 `return next()` 把请求交还应答链）；会话事件 `tool/call` 且 `name === "ask_user_question"` 作为兜底。两条路径共用 1.5 秒去重，同一次提问只响一声 |
| `stream-end` | `connection.generation` 变为 `undefined`，或 `connection.state` 进入 `disconnected`；两条信号共用 5 秒防抖 |
| `subagent-complete` / `last-subagent-complete` | `sessions.list` 快照中 `origin === "subagent"` 行的 `running` 翻转；**所有会话**（含后台会话）中运行中的子代理数量从 ≥1 降到 0 时触发「最后一个」 |

「当前会话」的判定：`sessions.list` 快照形如 `{ byId, phase }`，**没有 `current` 字段**；
当前会话是 `retainedBy.mainView > 0` 的那一行（DSH 客户端自身的约定）。它只用来决定
**订阅哪个会话的实时事件窗口**，不再用于过滤：插件已取消「仅当前会话响铃」，
任何会话（含后台会话）触发的情况都会照常响铃。

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
dsh plugin add ./dsh-sound-player-0.2.0.tgz
```

### 手动注册（无 bundle 时的兜底）

在 profile 的 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: sound-player
      name: dsh-sound-player
```

之后无需改动任何官方文件，**重启 DSH 桌面端**并刷新页面，即可在设置菜单看到「音效播放器」。

## 在 dshfind.com 上被发现

本仓库打上 GitHub topic：`dsh-plugin`（在仓库 Settings → Topics 添加），即可被
[dshfind.com](https://dshfind.com) 收录 —— 它索引 topic 为 `dsh-plugin` 的公开仓库。

## 结构

- `package.json` — 声明 `dsh.client`（`platform: "web"`，桌面端加载的就是这套客户端 bundle，不是分发渠道）与 `dsh.bundle`（自注册行）
- `cordis.patch.yml` — 注册本插件的宿主端行（plugin row）
- `lib/index.js` — 宿主端：音效库的读取/导入/删除/打开端点，注册在已认证的共享 RPC 通道（`/api`）上
- `client.js` — 客户端全部功能（音效库消费 / 音效引擎 / 事件监听 / API / 设置页 UI），随桌面端渲染进程运行；无悬浮窗
- `sounds/默认音效库/` — 内置合成音效（`合成音效/*.json`）与 Windows 提示音（`Windows 系统提示音/*.wav`）
- `sounds/神人音效库/` — 34 个内置 meme / 游戏音效（`命名对照.md` 记录原名与出处）
- `sounds/自定义音效库/` — 使用者导入的音效（本机数据，已 gitignore；目录缺失时自动创建）
- `test/library-host.cjs` — 宿主端端点无头测试（目录树 / 读取 / 导入去冲突 / 路径越界 / 删除限制）
- `test/event-chain.cjs` — 客户端无头自检：把真实宿主 handler 当 RPC 传输层接上，断言 7 类触发、
  逐条音量、抗重复、级联选择器结构

## 客户端前置（inject）

`dsh.client.inject` 声明的包级依赖为：
`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-runtime`。
运行时服务依赖（`exports.inject`）：`connection`、`sessions`、`slots`。
宿主端不硬依赖任何服务：拿不到 `ctx.connection.rpc.intercept` 时只是不暴露库端点，
客户端会显示「音效库不可用」并静默降级。

## 注意事项

- 自动播放策略（桌面端渲染进程沿用 Chromium 策略）：需要界面有过一次鼠标/键盘交互后
  音效才会出声，插件会在首次交互时自动恢复 AudioContext。
- **音效库就是插件目录里的真实文件**：绑定下拉里浏览 `sounds/` 下的三个库，容量、
  改名、加子文件夹都直接用文件管理器操作（设置页「打开音效库」一键打开）。
  音乐文件以 MP3/WAV/OGG 等常见格式放在库里即可；`默认音效库/合成音效/*.json`
  是 Web Audio 配方，手改里面的音符参数就能自定义合成音。
- **导入的音效落到 `sounds/自定义音效库/`**，导入文件夹会保留子目录结构；重名自动加
  `-2` 后缀。该目录已 gitignore——它属于本机数据，不会被推到仓库。
- 配置仍然只存在 localStorage：每条绑定的音效（库内相对路径）、音量、开关。
  配置 v4 → v5 会把老的内置 id 自动换成库内路径；旧版存在浏览器 IndexedDB 里的
  导入音效会在首次启动时搬到「自定义音效库」，只做一次。
- 音量是**逐条绑定**的属性；播放时只读这条绑定自身的音量，没有任何全局音量参与。
  配置从 v2 升到 v3 时会自动把老的全局音量写进每条情况作为初值（升级后响度不变）。
- 每条绑定另有「播放区间」与「特效」：`clipStart` / `clipEnd`（毫秒，`clipEnd` 为空
  表示播到结尾）、`effect`（`"fade-out"`＝渐弱消失）。音频文件按 `start(offset, duration)`
  截取；合成音效会把落在区间外的音符去掉、跨界音符按区间截断。配置 v5 → v6 会给老配置
  补上默认值（起点 0、终点空、无特效），升级后播放范围不变。
- 「服务终止」在连接代际消失（`generation` → `undefined`）或连接状态进入
  `disconnected` 时播放一次，带 5 秒防抖，避免重连抖动重复响。
- 「子代理运行完成」通过 `sessions.list` 快照中 `origin === "subagent"` 行的
  `running` 状态翻转检测；「最后一个子代理运行完成」在**所有会话**中运行中的
  子代理数量从 ≥1 降到 0 时触发。父会话字段同时兼容 `parentSessionId`（Host 摘要）
  与 `parentId` 两种命名。
- 不再按会话过滤：插件已取消「仅当前会话响铃」设置，后台会话、其它会话触发的情况
  同样会响铃（配置 v3 → v4 会丢弃老的该字段）。实时事件仍来自当前会话的事件窗口，
  子代理检测则覆盖全部会话。
- **同一个音效同一时刻只保留一路发声**：再次触发会先掐掉上一路。所以把两条情况绑到
  同一个音效时不会叠成「多重音效」；想要叠加效果就给它们绑不同的音效。
- **抗重复播报**（两层防御）：① 插件在页面级做单实例收编——重新挂载（热更新 / 连接
  代际重挂）时先收掉上一份运行时，避免旧 watcher 继续订阅事件窗口；② 对
  `(会话, seq)` 做全页幂等，同一个事件即使被重复投递也只响一次。
  `test/event-chain.cjs` 里有对应用例（旧实现会一次事件响 2 遍）。
- `sessions.list` 与 `connection.generation` 属于客户端运行时的内部快照存储，
  未出现在官方客户端服务契约（cordis-inspect 目录）里。插件对它们的读取都做了
  判空与 `try/catch`：接口缺失时静默降级，不影响其他功能。桌面端升级后建议重跑
  `test/event-chain.cjs` 与 `test/library-host.cjs` 确认契约未变。
- 「服务终止」在连接代际消失（`generation` → `undefined`）或连接状态进入
  `disconnected` 时播放一次，带 5 秒防抖，避免重连抖动重复响。
- 「子代理运行完成」通过 `sessions.list` 快照中 `origin === "subagent"` 行的
  `running` 状态翻转检测；「最后一个子代理运行完成」在**所有会话**中运行中的
  子代理数量从 ≥1 降到 0 时触发。父会话字段同时兼容 `parentSessionId`（Host 摘要）
  与 `parentId` 两种命名。
- 不再按会话过滤：插件已取消「仅当前会话响铃」设置，后台会话、其它会话触发的情况
  同样会响铃（配置 v3 → v4 会丢弃老的该字段）。实时事件仍来自当前会话的事件窗口，
  子代理检测则覆盖全部会话。
- **同一个音效同一时刻只保留一路发声**：再次触发会先掐掉上一路。所以把两条情况绑到
  同一个音效时不会叠成「多重音效」；想要叠加效果就给它们绑不同的音效。
- **抗重复播报**（两层防御）：① 插件在页面级做单实例收编——重新挂载（热更新 / 连接
  代际重挂）时先收掉上一份运行时，避免旧 watcher 继续订阅事件窗口；② 对
  `(会话, seq)` 做全页幂等，同一个事件即使被重复投递也只响一次。
  `test/event-chain.cjs` 里有对应用例（旧实现会一次事件响 2 遍）。
- `sessions.list` 与 `connection.generation` 属于客户端运行时的内部快照存储，
  未出现在官方客户端服务契约（cordis-inspect 目录）里。插件对它们的读取都做了
  判空与 `try/catch`：接口缺失时静默降级，不影响其他功能。桌面端升级后建议重跑
  `test/event-chain.cjs` 确认契约未变。

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
   - **每条绑定下方各有自己的音量滑块**，互不影响——对话完成可以响亮、子代理完成可以很轻；
   - 导入音频：选择文件 / 选择文件夹 / 拖拽音频到设置页。

2. **内置默认音效**（开箱即用，七种默认情况已预绑定）
   - **合成音效（免费、无版权，Web Audio 实时生成）**：提示音1（叮）、提示音2（双叮）、完成音（上扬）、通知音（钟声）、询问音、成功音（和弦）、警告音、停止音（下行）；
   - **内嵌 Windows 系统提示音**：系统提示音·叮（ding.wav）、系统提示音·启动（Windows Startup.wav）、系统提示音·默认（Windows Default.wav）；
   - 内置音效标记为 `[合成]` / `[系统]`，不可删除，随时可重新绑定。

3. **内置情况**
   - 对话完成提示（`turn-end`）
   - 发送消息时提示（你发送消息，`user-message`）
   - 权限请求时提示（`approval-requested`）
   - 被提问时提示（AI 弹 `ask_user_question`，`question-requested`）
   - 服务终止时提示（连接断开，`stream-end`）
   - **子代理运行完成**（`subagent-complete`，任意子代理跑完）
   - **最后一个子代理运行完成**（`last-subagent-complete`，所有会话中运行中的子代理全部完成）

4. **供其他插件使用的 API**（`ctx.get("soundPlayer")` 或 `window.__dshSoundPlayer__`）
   - 导入音频：`importAudioFile(file)` / `importAudioFiles(files)` / `importAudioDir(files)`
   - 增添情况：`addSituation({ label, trigger, audioId?, enabled?, volume? })` → 返回 id
   - 触发情况并播放音效：`triggerSituation(id)` / `trigger(id)`
   - 修改情况：`setSituation(id, patch)`、`setSituationEnabled(id, b)`、`setSituationAudio(id, audioId)`、`setSituationVolume(id, v)`、`removeSituation(id)`
   - 其他：`listSounds()` / `listSoundsMeta()` / `deleteSound(id)` / `listSituations()` / `getState()` / `setEnabled` / `setVolume`（兼容入口，批量写入所有情况，非全局音量）/ `subscribe(fn)` / `stopAll()`

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
- `lib/index.js` — 宿主端（Node half）占位
- `client.js` — 客户端全部功能（存储 / 音效引擎 / 事件监听 / API / 设置页 UI），随桌面端渲染进程运行；无悬浮窗
- `test/event-chain.cjs` — 无头自检：桩化客户端运行时，断言 7 类触发是否真的接通

## 客户端前置（inject）

`dsh.client.inject` 声明的包级依赖为：
`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-runtime`。
运行时服务依赖（`exports.inject`）：`connection`、`sessions`、`slots`。

## 注意事项

- 自动播放策略（桌面端渲染进程沿用 Chromium 策略）：需要界面有过一次鼠标/键盘交互后
  音效才会出声，插件会在首次交互时自动恢复 AudioContext。
- 音频数据保存在 IndexedDB（`dsh-sound-player` 库），配置保存在 localStorage，
  均只对本机这份桌面端数据生效；清除客户端站点数据会清掉音效库。
- 音量是**逐条绑定**的属性，随情况一起存在 localStorage 里；播放时只读这条绑定自身的
  音量，没有任何全局音量参与。配置从 v2 升到 v3 时会自动把老的全局音量写进每条情况
  作为初值（升级后响度不变），然后丢弃全局字段——升级不会重置你已调好的音效库。
- 「服务终止」在连接代际消失（`generation` → `undefined`）或连接状态进入
  `disconnected` 时播放一次，带 5 秒防抖，避免重连抖动重复响。
- 「子代理运行完成」通过 `sessions.list` 快照中 `origin === "subagent"` 行的
  `running` 状态翻转检测；「最后一个子代理运行完成」在**所有会话**中运行中的
  子代理数量从 ≥1 降到 0 时触发。父会话字段同时兼容 `parentSessionId`（Host 摘要）
  与 `parentId` 两种命名。
- 不再按会话过滤：插件已取消「仅当前会话响铃」设置，后台会话、其它会话触发的情况
  同样会响铃（配置 v3 → v4 会丢弃老的该字段）。实时事件仍来自当前会话的事件窗口，
  子代理检测则覆盖全部会话。
- `sessions.list` 与 `connection.generation` 属于客户端运行时的内部快照存储，
  未出现在官方客户端服务契约（cordis-inspect 目录）里。插件对它们的读取都做了
  判空与 `try/catch`：接口缺失时静默降级，不影响其他功能。桌面端升级后建议重跑
  `test/event-chain.cjs` 确认契约未变。

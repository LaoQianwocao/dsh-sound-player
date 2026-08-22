# dsh-sound-player — DSH Web 音效播放器

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 开发的**音效播放器**插件，
以**悬浮窗**形式常驻对话界面。发布为 DSH 客户端插件（`dsh.client`），支持 GitHub / npm / tarball 分发。

> 本插件是「音效播放器」，与另一个名为 dev-board / 开发者黑板 的插件项目无关。

## 功能

1. **悬浮窗音效播放器**
   - 常驻对话界面，可**任意拖动**；
   - 拖动松手时随机播放一种弹出动画（滑动 / 缩放 / 上浮 / 翻转 / 淡入）；
   - 点击悬浮窗打开配置弹窗。

2. **配置弹窗**（悬浮状态下点击悬浮窗打开）
   - 导入音频：选择文件 / 选择文件夹 / 拖拽音频到弹窗；
   - 为每种「情况」绑定音效并开关，显示格式如 `【√】发送消息时播放【提示音1】`；
   - 总开关、音量、仅当前会话响铃等选项。

3. **内置默认音效**（开箱即用，五种默认情况已预绑定）
   - **合成音效（免费、无版权，Web Audio 实时生成）**：提示音1（叮）、提示音2（双叮）、完成音（上扬）、通知音（钟声）、询问音、成功音（和弦）、警告音、停止音（下行）；
   - **内嵌 Windows 系统提示音**：系统提示音·叮（ding.wav）、系统提示音·启动（Windows Startup.wav）、系统提示音·默认（Windows Default.wav）；
   - 内置音效标记为 `[合成]` / `[系统]`，不可删除，随时可重新绑定。

4. **内置情况**
   - 对话完成提示（`turn/end`）
   - 发送消息时提示（你发送消息，`user/message` source=user）
   - 权限请求时提示（`approval/requested`）
   - 被提问时提示（AI 弹 `ask_user_question`，`question/requested`）
   - 服务终止时提示（mux 流断开 / `stream/error`）

5. **供其他插件使用的 API**（`ctx.get("soundPlayer")` 或 `window.__dshSoundPlayer__`）
   - 导入音频：`importAudioFile(file)` / `importAudioFiles(files)` / `importAudioDir(files)`
   - 增添情况：`addSituation({ label, trigger, audioId?, enabled? })` → 返回 id
   - 触发情况并播放音效：`triggerSituation(id)` / `trigger(id)`
   - 修改情况：`setSituation(id, patch)`、`setSituationEnabled(id, b)`、`setSituationAudio(id, audioId)`、`removeSituation(id)`
   - 其他：`listSounds()` / `listSoundsMeta()` / `deleteSound(id)` / `listSituations()` / `getState()` / `setEnabled` / `setVolume` / `setOnlyCurrentSession` / `subscribe(fn)` / `stopAll()`

## 触发方式（trigger）取值

| trigger | 含义 |
| --- | --- |
| `turn-end` | 对话完成（AI 结束一轮回答） |
| `user-message` | 发送消息时 |
| `approval-requested` | 权限请求时 |
| `question-requested` | 被提问时 |
| `stream-end` | 服务终止时 |
| `manual` | 手动触发（由插件调用 `triggerSituation(id)`） |

插件可通过 `addSituation` 注册自己的情况，并用 `triggerSituation(id)` 触发；把
自定义 trigger 值传给 `addSituation` 后，需由插件自己在合适的时机调用
`triggerSituation(id)` 播放（框架只识别上面列出的内置 trigger 事件）。

## 安装

要求已安装 `dsh` CLI（`dsh --help` 存在）。

### 从 GitHub 安装（推荐）

```sh
# 私有/未绑定账号的仓库记得改成你自己的 owner 与提交
dsh plugin add github:<YOUR_GITHUB_USER>/dsh-sound-player
```

第一次安装若 pnpm 提示需要允许构建脚本，把打印出的包 `key` 填入
profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，然后重跑 `add`。

### 从本地 tarball 安装

```sh
pnpm pack
dsh plugin add ./dsh-sound-player-0.1.0.tgz
```

### 手动注册（无 bundle 时的兜底）

在 profile 的 `cordis.patch.yml` 中插入：

```yaml
- insert:
    - id: sound-player
      name: dsh-sound-player
```

之后无需改动任何官方文件，**重启 dsh web 服务**并刷新浏览器页面，即会出现喇叭悬浮窗。

## 在 dshfind.com 上被发现

本仓库打上 GitHub topic：`dsh-plugin`（在仓库 Settings → Topics 添加），即可被
[dshfind.com](https://dshfind.com) 收录 —— 它索引 topic 为 `dsh-plugin` 的公开仓库。

## 结构

- `package.json` — 声明 `dsh.client`（platform: web）与 `dsh.bundle`（自注册行）
- `cordis.patch.yml` — 注册本插件的宿主端行（plugin row）
- `lib/index.js` — 宿主端（Node half）占位
- `client.js` — 浏览器端全部功能（存储 / 音效引擎 / 事件监听 / API / 悬浮窗 UI）

## 客户端前置（inject）

`dsh.client.inject` 声明的包级依赖为：
`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-runtime`。

## 注意事项

- 浏览器自动播放策略：需要页面有过一次鼠标/键盘交互后音效才会出声（插件会在
  首次交互时自动恢复 AudioContext）。
- 音频数据保存在浏览器 IndexedDB（`dsh-sound-player` 库），配置保存在 localStorage，
  均只对本浏览器生效；清浏览器数据会清掉音效库。
- 「服务终止」音效在连接断开约数秒内播放一次（带防抖），避免重连抖动重复响。

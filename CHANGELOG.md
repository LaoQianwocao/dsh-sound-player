# Changelog

本项目的所有重要变更将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-09-06

### Fixed

- **兼容 DSH 0.1.2-rc.1**：0.1.2-rc.1 移除了运行时信封流 API
  （`connection.api.subscribeEnvelopes` / `connection.hostDescription`），
  导致除手动触发外全部提示音静默失效。重写 `startWatchers` 为 4 路官方事件源：
  - `remote.$on("api-session/status")`（running 翻转边沿）→ 对话完成
  - `uiSession.pendingInteractions` 快照 store → 权限请求 / 被提问（含计划评审）
  - 逐会话 `sessions.binding(id).eventSource`（仅认 `append` 活事件）→ 发送消息
  - `connection.state`（connected→disconnected 边沿）→ 服务终止
  - 兼容 0.1.2-rc.1 eventSource entry 的 `{type: "event", event: SessionEvent}` 双层信封结构
- `exports.inject` 增加 `remote`、`uiSession` 依赖服务
- `package.json` 的 `dsh.client.inject` 移除已不存在的
  `@deepseek-ai/dsh-client-runtime`，按 0.1.2-rc.1 实际服务提供者补齐

### 验证

- DSH 0.1.2-rc.1（桌面壳 2.0.5）实测：对话完成 / 发送消息 / 子代理完成 /
  最后一个子代理完成 4 类音效触发正常（插件触发日志 + 听觉双重确认）；
  权限请求 / 被提问 / 服务终止按官方 UI 源码形状实现并经订阅挂载验证。
- 详见 issue #3 与 PR #4。

### 贡献者

- alonewinds（alonewinds2024@163.com）

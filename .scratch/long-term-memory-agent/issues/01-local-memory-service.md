# 01: 启动可用的本地记忆服务

**What to build:** 用户可以启动 Aquarius 本地后台服务，并通过 CLI 验证 API、认证、SQLite 和独立 memory Git repository 均已就绪。服务使用 OpenAI Agents SDK for TypeScript 作为后续 Agent run 的运行时，但本切片不要求产生任何长期记忆。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 服务只监听 localhost，并拒绝缺失或错误 bearer token 的请求。
- [ ] 首次启动能够创建或迁移 SQLite 运行状态，并初始化独立的 memory Git repository，而不把应用代码仓库当作记忆仓库。
- [ ] OpenAI API key、固定模型配置和 memory repository 位置缺失时，服务给出可操作的启动错误，不进入半可用状态。
- [ ] CLI 通过本地 API 工作；`doctor` 能检查服务版本、认证、数据库、Git repository 和模型配置。
- [ ] OpenAI Agents SDK 远程 tracing 默认关闭，本地日志不记录 token、密钥或完整请求正文。
- [ ] 自动化测试覆盖健康检查、错误认证、首次初始化和重复启动。


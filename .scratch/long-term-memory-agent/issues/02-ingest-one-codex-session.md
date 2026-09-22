# 02: 将单个 Codex 会话沉淀为经历

**What to build:** 用户手动指定一个 Codex session 后，Aquarius 能把它安全地解析、脱敏并交给基于 OpenAI Agents SDK 的 MemoryExtractorAgent，最终在 Git HEAD 中写入一条可查看、有来源的经历记忆。

**Blocked by:** 01: 启动可用的本地记忆服务

**Status:** ready-for-agent

- [ ] Codex adapter 能读取活动目录或归档目录中的一个 JSONL session，并转换为稳定的 normalized session；未知事件类型不会导致整次导入失败。
- [ ] API key、token、密码、私钥和常见凭据在任何模型调用、日志或 Git commit 之前被替换。
- [ ] MemoryExtractorAgent 只能返回通过 Zod 校验的结构化 observation，并且没有 shell、网络、文件写入或 Git 写入工具。
- [ ] 只有用户消息和可验证工具结果能够成为经历事实证据；Agent 自己的推测不能作为用户事实。
- [ ] 成功摄取后，Git HEAD 中存在符合 frontmatter 契约的经历及必要脱敏证据，并产生包含 job ID、session ID 和源哈希的 commit。
- [ ] 用户能通过 CLI/API 查看新经历及其 memory ID、来源和置信信息。
- [ ] 重复导入相同内容不会创建第二条经历或第二次有效提交。


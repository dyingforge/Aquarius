# 04: 用当前记忆回答并给出引用

**What to build:** 用户通过 CLI 或 API 提问时，Aquarius 能从 Git HEAD 的当前有效记忆中检索相关内容，并由 MemoryQueryAgent 给出带 memory ID 的回答，而不是回放完整历史会话。

**Blocked by:** 02: 将单个 Codex 会话沉淀为经历

**Status:** ready-for-agent

- [ ] Git HEAD 中的 active memories 能生成小型 memory summary，并投影到可重建的 SQLite FTS5 索引。
- [ ] 查询先加载 summary，再使用 FTS 筛选候选，最后只把相关 active memory 和必要证据交给 MemoryQueryAgent。
- [ ] MemoryQueryAgent 使用 OpenAI Agents SDK 的受限只读工具，无法读取 Git 历史、候选 Skill 或任意本机文件。
- [ ] 回答标出实际使用的 memory ID；证据不足或互相冲突时明确表达不确定性。
- [ ] 已过期、被替换、待审或 retired 的记忆不会作为当前事实进入普通问答上下文。
- [ ] CLI 与 HTTP API 对同一问题返回同一结构化响应契约。
- [ ] SQLite FTS 被删除后能够仅依据 Git HEAD 完整重建，并恢复相同的可检索条目集合。


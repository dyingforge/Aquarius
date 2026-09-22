# 05: 跨案例自动沉淀画像与策略

**What to build:** 当多个独立 Codex 案例持续支持同一偏好或做事策略时，Aquarius 能通过 MemoryConsolidatorAgent 识别它们，并在确定性门禁满足后自动晋升为当前画像或策略，让后续问答实际使用该记忆。

**Blocked by:** 02: 将单个 Codex 会话沉淀为经历; 04: 用当前记忆回答并给出引用

**Status:** ready-for-agent

- [ ] MemoryConsolidatorAgent 能将新 observation 与 FTS 返回的相关记忆比较，并提出新增、加强、重复、时间变化或冲突操作。
- [ ] 同一根线程的续聊只计算为一个 case；模型自己的历史回答不能增加独立证据数。
- [ ] 推断画像或策略只有在至少两个独立 case、模型置信为 high 且没有未解决冲突时自动晋升。
- [ ] 用户明确提出的画像或策略要求可以跳过案例数量门槛，并记录 `user_explicit` 权威来源。
- [ ] 未达到门槛的内容保留为候选，不出现在普通问答的当前事实中。
- [ ] 晋升操作由 TypeScript 门禁决定并提交 Git；MemoryConsolidatorAgent 无法直接修改 repository。
- [ ] 晋升后的画像或策略能够在相关查询中被召回，并显示支撑 case。


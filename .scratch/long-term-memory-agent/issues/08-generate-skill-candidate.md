# 08: 从重复策略生成 Skill 候选

**What to build:** 当同一策略在多个不同任务中反复成功时，Aquarius 能自动识别复用价值，并通过 SkillSynthesizerAgent 生成一份可供用户审阅、但尚未安装的声明式 Skill 候选。

**Blocked by:** 05: 跨案例自动沉淀画像与策略

**Status:** ready-for-agent

- [ ] 只有至少三个独立成功 case、至少两个不同任务特征支撑同一策略时，才触发 Skill 候选生成。
- [ ] 成功证据必须来自用户结果或可验证工具结果；Agent 自评不能单独证明成功。
- [ ] SkillSynthesizerAgent 使用 OpenAI Agents SDK，并且只能读取关联策略和脱敏案例、返回结构化 Skill 候选。
- [ ] 候选包含名称、用途、触发条件、输入、输出、步骤、不适用范围和关联 case。
- [ ] 第一版 Skill 仅允许 Markdown 指南以及 Prompt/工具 Schema，不包含可执行代码或自动授予的工具权限。
- [ ] 候选存在秘密、绝对本机路径、缺失依赖声明或明显重复名称时进入异常待审，而不是成为可发布候选。
- [ ] 新候选只写入 Git 的 candidate 区域，不能自动进入 published 或 Codex skills 目录。


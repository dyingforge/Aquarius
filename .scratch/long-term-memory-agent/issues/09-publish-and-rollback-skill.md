# 09: 批准、安装和回滚 Skill

**What to build:** 用户审阅 Skill 候选后，可以明确批准并安装到 Codex；Aquarius 会先把批准版本发布到 canonical Git，再进行确定性安装，并允许用户拒绝候选或回滚已安装版本。

**Blocked by:** 08: 从重复策略生成 Skill 候选

**Status:** ready-for-agent

- [ ] 用户可以查看候选 Skill、关联策略、支撑案例、安装目标和与现有 Skill 的名称冲突。
- [ ] 发布必须有用户明确批准；没有审批记录时，任何后台任务或 Agent 都不能发布或安装。
- [ ] 发布门禁只执行格式、必填输入输出、来源 case、敏感信息和安装冲突的静态校验，不运行语义质量评测或强制试运行。
- [ ] 批准后先提交到 Git 的 published 区域，再由确定性安装器投影到 Codex skills 目录。
- [ ] 安装器不会覆盖非 Aquarius 管理的同名 Skill；冲突时停止并返回可处理的错误。
- [ ] SQLite 记录 published commit、安装位置和文件哈希，Git 仍是 Skill 内容的 canonical source。
- [ ] 用户可以拒绝候选、retire 已发布版本，或回滚到上一个已发布并安装的版本。
- [ ] 安装失败不会把未安装版本报告为可用；修复后重试保持幂等。


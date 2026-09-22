# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前处于首个垂直切片的完成点。

## [0.1.0] — 2026-09-22

首个可用版本：本地记忆服务、Codex 摄取、记忆门禁、检索问答、修正与审查、Skill 生命周期、调度与启动对账全部落地。测试 85 个，另用本机真实 Codex 会话做过端到端验证。

### 新增

- **本地服务与认证**（ticket 01）：Fastify 只监听 `127.0.0.1`；缺失或错误 bearer token 一律 401，非 loopback 来源 403（即使 token 正确）。首次启动生成 API token（`config.json`，0600）、初始化 SQLite（带 migration）与**独立的**记忆 Git 仓库。`doctor` 检查服务版本、认证、数据库、Git 仓库、模型配置、源目录、索引一致性与安装目录。
- **会话摄取**（ticket 02）：Codex JSONL 适配器读取活动会话、归档会话与 session index；未知事件类型计数后跳过，截断尾部与坏行不会导致批次失败；注入式 harness 消息不会被当作用户原话。脱敏在任何模型调用、日志与 Git 写入之前执行。
- **增量与幂等**（ticket 03）：按 session/event 指纹、内容哈希与 adapter schema version 建立 checkpoint；追加内容只消费新事件；移入归档不重复生成记忆；仍在写入的会话延后处理；同一根线程的续聊只算一个 case。
- **检索与问答**（ticket 04）：`summary/MEMORY.md` 渐进式加载 + SQLite FTS5 候选筛选 + 相关性选择；回答必须标注实际使用的 memory ID，证据不足时明确说明。FTS 为 Git HEAD 的派生投影，删库后可完整重建并恢复相同检索集合。中文用 bigram 增强实现可检索。
- **画像与策略晋升**（ticket 05）：确定性门禁；推断项需要两个独立 case + 高置信 + 无未解决冲突；用户明确陈述立即生效并记为 `user_explicit`。
- **记忆修正**（ticket 06）：自然语言修正的分类（纠错 / 时间变化 / 忘记 / 内容编辑）、隔离暂存区 diff 预览、确认时的 `expectedHead` 校验、取消无副作用、过期预览失效。
- **冲突审查**（ticket 07）：冲突、低置信、敏感候选进入 review 队列且不作为当前事实；支持采纳 / 合并 / 拒绝 / 时间变化，全部先展示最终 diff；决定只可应用一次；新证据推翻已决结论会开新 review 而不是静默覆盖。
- **Skill 生命周期**（ticket 08、09）：≥3 独立成功 case 且 ≥2 种任务特征才生成候选；候选只写 `skills/candidates/`；静态发布门禁（格式、来源 case、敏感信息、绝对路径、未声明工具依赖、可执行代码、同名冲突）；发布需明确批准，先提交 Git 再由确定性安装器投影到 Codex skills 目录，带 `aquarius_managed` 标记；绝不覆盖非 Aquarius 管理的同名 Skill；支持拒绝、retire 与回滚。
- **调度与恢复**（ticket 03 续）：launchd 只负责常驻；每日 03:00（Asia/Shanghai）由应用调度，错过窗口在下次启动补跑，每个自然日至多一次自动批次；任务有界重试（最多 3 次，指数退避）；Git 已提交而 SQLite 未更新时启动自动对账。

### 修复（开发期发现并修复的真实缺陷）

- 提交日志解析按换行切分，导致多行 commit body 被截断、`Aquarius-*` trailer 读不到（对账与回滚依赖它）。改为 NUL/RS 分隔字段。
- `git diff-tree` 未递归子目录，导致树下的文件变更在预览里「看不到」。
- 脱敏规则遗漏中文自然语言写法（「密码是 xxx」），会让凭据进入 Git。
- 记忆门禁对 experience 忽略冲突，导致互相矛盾的陈述可以同时成为当前事实。
- 冲突审查的候选复用了目标记忆的 ID，可能把 active 记忆降级为 candidate。
- 合并决策只并集 `supporting_case_ids`，丢掉反方案例；时间变化决策改写旧条目而不是关闭其有效期。
- 内容派生的 review 去重键在决策之后仍然生效，导致新证据无法开启新 review。
- 与已归档（superseded）记忆「重复」的观测被直接丢弃，使独立 case 计数无法增长、Skill 永远无法触发。
- 单会话任务被错误地执行成整批摄取，会把未指定的其他会话一起消化（由真实会话 smoke test 发现）。

### 已知限制

见 [DESIGN.md](DESIGN.md) 第 7 节「已知薄弱点」与 [docs/PROJECT-SPEC.md](docs/PROJECT-SPEC.md)「首版不做」。

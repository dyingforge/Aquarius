# REGISTRY — 记忆与 Skill 的构建、校验与分发

原文档树此处注释为「组件构建、校验和分发说明」。Aquarius 的「可注册产物」有两类：**记忆记录**（写入记忆仓库）和 **Skill**（从记忆派生、安装到 Codex）。本文件说明它们如何被构建、校验、存储与分发，以及各环节的失败语义。

## 1. 两类产物的对照

| 维度 | 记忆记录 | Skill |
| --- | --- | --- |
| 存储位置 | `active/`、`candidates/`、`archive/` | `skills/candidates|published|retired/` |
| 构建者 | 摄取流水线（Agent 提议 + 门禁判定）| SkillSynthesizerAgent（仅在门禁达标后）|
| 校验 | frontmatter zod 契约 + 敏感信息 + 路径 | 契约 + 静态门禁 + 独立任务评测报告 |
| 分发 | 无需分发：检索按状态读取 | 确定性安装器复制到 `~/.codex/skills/<name>/SKILL.md` |
| 批准 | 晋升由确定性门禁决定；冲突/敏感由用户裁决 | **必须**用户明确批准 |
| 回滚 | 修正/时间变化会关闭旧条目有效期 | 回滚到上一已发布版本并重装 |

## 2. 记忆记录的构建与校验

### 2.1 构建路径

```text
session → 脱敏 → 提取观测 → 合并提议 → 门禁判定 → buildRecord → 契约校验 → 提交
```

`buildRecord`（`pipeline/ingest.ts`）负责把「观测 + 门禁结论 + 知识来源」合成一条记忆：

- `id`：新建用 `newMemoryId(kind)`（类型前缀 + ULID）；更新沿用原 id；review 候选使用**内容派生 ID**（`cnd_<hash>`），保证重复运行不会堆出多份候选。
- `authority`：由 `verifyAuthority()` 从被引用证据**重算**，不采信模型声明。
- `supporting_case_ids` / `contradicting_case_ids`：按 case 集合维护；冲突观测记入 contradicting 而不是 supporting。
- `provenance`：来源、adapter、session、根线程、源文件路径、内容哈希、事件 ID、case ID、采集时间——全部已脱敏。
- `valid_from`：新建或时间变化时置为当前；`valid_to` 只在关闭有效期时出现。

### 2.2 校验（提交前，任一失败即拒绝整次写入）

| 检查 | 实现 | 失败语义 |
| --- | --- | --- |
| frontmatter 契约 | `memoryFrontmatterSchema.safeParse`（含 6 条跨字段规则）| `validation_failed`，整批不提交 |
| 路径合法性 | `assertSafeMemoryPath`（禁止绝对路径、`..`、树外前缀）| `validation_failed` |
| 敏感信息 | `Redactor` 二次扫描 | `validation_failed`，不落盘 |
| 引用完整性 | 事件 ID 必须能在本次证据集中解析 | 无有效引用的观测直接 `reject` |

跨字段规则：`schema_version` 必须匹配；`superseded` 必须带 `superseded_by`；`active` 不得带已关闭的 `valid_to`；`inferred`+`high` 必须引用支撑 case；`kind=skill` 必须有 `skill` 块；`valid_to >= valid_from`。

### 2.3 读模型校验

`MemoryRepository.snapshot()` 读取 HEAD 上每个 `.md` 并逐条校验。**校验失败的记录不会被静默忽略**：

- 不进入索引与问答视图；
- 路径出现在 `health.memoryRepo.invalidFiles`；
- `doctor` 报 `memory-files` warn 并给出前三条原因。

这样即使有人手工改了记忆仓库，也不会「悄悄消失」。

## 3. Skill 的构建与校验

### 3.1 触发条件（全部满足才生成候选）

1. 支撑策略状态为 `active`。
2. ≥3 个独立 case 有针对该策略尝试的显式确认 `success` 结果；普通用户消息、单项工具成功和 Agent 自评都不算。
3. ≥2 种不同任务特征。
4. 该策略没有未解决冲突，且尚未存在未决候选。已有发布版仅在出现新结果或新支撑 case 时生成修订候选。

不满足时不生成任何东西，只在任务统计里记录原因（`aquarius ingest status` 可见）。

结果记录用 `aquarius case-outcome <caseId> <strategyId> <attemptId> <result> --evidence <ids>` 写入；须指定当前 `expectedHead`、该策略实际引用的 case、已存于 Git 的证据 ID。修正用 `--supersedes <outcomeId>` 追加记录；未解除的矛盾为 `unknown`。旧 case 不自动补成功。

### 3.2 候选构建

```text
strategy + cases + 脱敏证据 → SkillSynthesizerAgent → skillDraftSchema
  → 名称折叠为 kebab-case（不可写名称先规范化）
  → validateSkillCandidate（静态检查）
  → 写入 skills/candidates/<skill_id>.md（kind=skill，status=candidate）
  → 有 flag → 同时开一条 skill_anomaly review（异常待审）
```

候选内容恒为声明式：名称、用途、触发条件、输入、输出、步骤、限制、工具依赖、关联策略与案例、生成理由。**不含可执行代码。**

修订候选另有 `revises_skill_id`、`base_commit_sha`、`base_content_hash`；候选 ID 与稳定发布 ID 分开。合成器接收发布版和新结果，名称固定为该发布版的安装名。

### 3.3 静态发布门禁

`validateSkillCandidate()` 的检查项与作用域：

| 检查 | flag | 扫描范围 |
| --- | --- | --- |
| 凭据/密钥 | `contains_secret` | 全文（含理由与引用）|
| 绝对路径 / `~/` | `absolute_local_path` | 全文 |
| 内嵌可执行代码块 | `executable_code` | **仅操作字段**（用途/触发/输入/输出/步骤/限制）|
| 未声明工具依赖 | `undeclared_tool_dependency` | **仅操作字段** |
| 名称不合规 | `invalid_name` | 名称 |
| 与已发布同名 | `duplicate_name` | 名称 |
| 支撑案例不足 3 | `insufficient_cases` | case 计数 |
| 缺少输入/输出/步骤 | `missing_required_fields` | 必填字段 |

作用域区分是刻意的：**引用证据里的普通词（例如 `npm`）不应让一份合法候选被隔离**，但秘密与路径在全文任何位置都不允许。

有 flag = 隔离：写入候选项时 `review_flags` 非空，且 `approveSkill` 直接拒绝（`forbidden`），必须先解决异常审查。

### 3.4 质量评测门禁

维护者先用 `aquarius skill suite-set <jsonFile>` 登记版本化任务集；已有候选和随后生成的候选会排队评测，也可用 `aquarius skill evaluate <candidateId>` 手动重跑。首版只支持 `release-checklist-v1`：至少一个适用成功场景、一个不适用场景、一个工具失败场景。来源 case 不能与合成案例重叠；维护者要保证人工编写的合成任务也未泄漏给合成器。

可从 [发布检查评测集样例](examples/release-checklist-evaluation-suite.json) 开始，替换策略 ID，并按真实任务的验收标准修改场景。样例中的 `source_case_id: null` 表示人工编写的合成任务，不自动证明它是独立保留集。

候选与基线在相同任务、相同模型及预算下调用隔离的 `run_typecheck` / `run_lint` 替身，评测器记录**实际工具请求顺序**并按预置返回值检查失败报告。没有真实 shell 或用户工作区写权限。候选必须通过所有场景、不能比基线退步，且至少修复一个预先登记的基线失败；`fake` 替身报告为 `insufficient_evidence`。报告包含候选、基线和任务集哈希，任一变化即 `stale`；`missing` / `fail` / `insufficient_evidence` / `stale` 均不能批准。此评测证明的是受控场景行为，不声称真实发布任务端到端通过。

## 4. 分发：确定性安装

```text
approve（用户批准）
  → 静态门禁 + 当前有效的质量报告 + 同名冲突检查（受管标记及所有者 ID）
  → 提交 Git：candidates/<candidateId>.md 删除，published/<stableId>.md 写入（status=active）
  → 记录 skill_approval 审查留痕
  → 重建投影
  → 安装：写 <skills-dir>/<name>/SKILL.md（带 aquarius 标记与来源 commit）
  → SQLite 记录 published commit / 安装路径 / 文件哈希 / 版本号
```

安装器规则：

1. 目标目录不存在、或带有相同 `aquarius_skill_id` 的受管标记时才可安装；其他同名目录 → **停止**，报 `skill_install_conflict`。
2. 安装文件头部写入：`aquarius_managed: true`、`aquarius_skill_id`、`aquarius_commit`，便于后续识别与对账。
3. Git 是 Skill 内容的 canonical source；安装只是投影，可以随时由 Git 重建。
4. 安装失败不会把版本报成「可用」：SQLite 里状态保持 `published`，只有文件确实写入并算出哈希才记为 `installed`。
5. 重试幂等：重复安装同一版本会重写同样内容并得到同样的哈希。

启动时会校验每个 `installed` 记录的文件是否存在、哈希是否匹配；不一致会在 `doctor` 与日志里报出来。

## 5. 回滚与退场

| 操作 | Git 效果 | 安装效果 | SQLite |
| --- | --- | --- | --- |
| `rollback` | 从上一发布 commit 读回内容，以新的 `skill_version` 写回 `skills/published/<id>.md` | 覆盖同 ID 受管安装并重算哈希 | 记录新 commit、`rollback_of` 指向被回滚的版本 |
| `retire` | 移到 `skills/retired/`，`status=retired`，关闭有效期 | 仅删除带标记的受管目录 | 记录 `retired_at` |
| `reject` | 移到 `skills/retired/`，`status=rejected` | 无（从未安装）| 无发布记录 |

回滚没有上一版本、或历史内容不满足契约时直接报错（`conflict` / `validation_failed`），不会产出半成品。

## 6. 版本与兼容

- 记忆契约版本：`schema_version`（当前 `1`）。写入方只写当前版本；读取方遇到不认识的版本会**报错而不是猜测**。
- adapter 版本：每个 `SessionSourceAdapter` 有自己的 `schemaVersion`，并记录在 checkpoint 里；格式语义变化时升版本，旧 checkpoint 会被重新处理。
- Skill 版本：每次发布和回滚均递增 `skill_version`，Git frontmatter 是版本事实源；SQLite 发布记录可重建。
- 升级步骤：改 `schema.ts` → 升版本号 → 写迁移说明（`ARCHITECTURE.md`）→ `CHANGELOG.md` 标 BREAKING → 补测试。

## 7. 注册流程检查清单

新增「可注册产物」或改动上述任一步骤时：

- [ ] 契约定义在一处，且校验发生在入口。
- [ ] 校验失败是**整批拒绝**，不是部分写入。
- [ ] 新产物有明确的「不进入当前事实」的默认状态（候选/隔离），而不是直接生效。
- [ ] 有对应的状态流转测试（包括「重复执行不产生第二条」）。
- [ ] 敏感信息在写入前被扫描；扫描范围与豁免理由写在本文件。
- [ ] 分发步骤是确定性的、可重放、带来源 commit 与哈希。
- [ ] 失败时不会把未生效的东西报告为可用。

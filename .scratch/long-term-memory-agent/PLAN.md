# Aquarius 长期记忆 Agent 实现计划

## 1. 产品目标与系统边界

Aquarius 是一个单用户、本地运行的长期记忆服务：

- 每天 03:00（Asia/Shanghai）增量读取 Codex sessions；错过任务时在下次启动后补跑。
- 用户可随时通过 CLI 或 localhost API 问答、查看和修正记忆。
- 记忆分为用户画像、经历、策略和 Skill。
- Git 是长期语义记忆的唯一事实源。
- SQLite 保存任务、游标、审批、运行记录和可重建检索索引。
- 第一版只接入 Codex，但保留其他 Agent 的 session adapter 接口。
- 不构建永久推理循环；长期存在的是本地服务、调度器和持久化数据，每次消化或问答都是有界 Agent run。
- 应用代码仓库与运行时 memory Git repository 必须分离。

## 2. 技术选型

### AI 与 Agent 层

- **OpenAI Agents SDK for TypeScript（`@openai/agents`）**：负责 Agent 定义、Agent loop、工具调用、guardrails、结构化输出和运行 tracing，是 Aquarius 的核心 Agent runtime。
- **Zod**：定义 Agent 输出、工具参数、记忆记录和 API 数据的运行时 Schema。
- **OpenAI 基础 TypeScript SDK（`openai`）**：第一版不作为直接依赖。Agents SDK 已负责模型调用；只有未来需要直接调用 Responses API 或尚未封装的接口时才加入。
- 使用单一、可配置并固定版本的 OpenAI 模型快照；消化、问答和 Skill 生成首版不做多模型路由。

### 应用层

- 当前 Node.js LTS，并固定具体版本。
- TypeScript + pnpm workspace。
- Fastify 提供 localhost HTTP API。
- SQLite + FTS5 保存运行状态和全文检索投影。
- 对原生 Git CLI 做窄封装，用于 canonical memory 提交、版本和恢复。
- macOS launchd 守护后台服务；定时语义由应用的持久任务表负责。

### 不直接采用 SDK 默认 Memory lifecycle

Agents SDK 的 Sandbox Memory 可以自动生成 `MEMORY.md`、raw memories、rollout summaries 和 skills，并允许 live update。Aquarius 只借鉴其处理模式：

```text
原始观察 → 候选记忆 → 合并沉淀 → 摘要 → 渐进式读取
```

最终 canonical memory 由自定义 TypeScript 业务层验证后写入 Git，不允许 SDK Memory 或模型直接修改正式仓库。

## 3. Agent 职责

Aquarius 使用 `@openai/agents` 实现四个有界 Agent。

### MemoryExtractorAgent

- 输入经过脱敏和归一化的 session 片段。
- 提取经历、画像观察、策略观察和案例特征。
- 只能返回通过 Zod 验证的结构化结果。
- 无 shell、网络、文件或 Git 写权限。

### MemoryConsolidatorAgent

- 接收新 observation 及 FTS 找到的相关记忆。
- 判断新增、重复、加强、冲突、时间变化或替换。
- 返回拟议的 memory operations，不执行写入。
- 不得把已有模型结论当作新的独立证据。

### MemoryQueryAgent

- 接收用户问题、memory summary 和检索候选。
- 通过受限工具读取当前 Git HEAD 中的 active memory。
- 回答必须标注使用的 memory ID；证据不足时明确说明。
- 不访问 Git 历史、候选 Skill 或无关审计记录。

### SkillSynthesizerAgent

- 在门禁确认出现三个独立成功案例后运行。
- 生成声明式 Skill 候选，包括适用条件、输入、输出、步骤和限制。
- 不生成可执行代码，不负责发布或安装。

所有 Agent run 都设置超时、token、工具调用次数和最大步数预算。

## 4. Session 摄取与消化

### Codex adapter

首版读取以下来源：

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`
- `~/.codex/session_index.jsonl`

核心 adapter 契约：

```ts
interface SessionSourceAdapter {
  discover(cursor?: SourceCursor): AsyncIterable<SessionRef>;
  read(ref: SessionRef): Promise<NormalizedSession>;
}
```

`NormalizedSession` 包含来源、session ID、根线程 ID、时间、工作目录、归一化消息、工具结果、事件 ID、源哈希和 adapter schema version。

Codex JSONL 是可变化的外部格式。未知事件被记录并跳过，不能导致整个批次失败；后续模块不得直接依赖 Codex 原始事件结构。

### 增量与幂等

- 使用 session ID、事件 ID、文件哈希和更新时间建立 checkpoint。
- 同一 session 后续追加内容时只处理新增事件。
- session 移入 archived 目录后不会重新生成记忆。
- 尚在持续写入的文件延后处理。
- 同一根线程的续聊只计算为一个独立 case。

### 敏感信息处理

在任何模型调用前执行确定性扫描，替换：

- API key、访问 token、密码和凭据字段。
- 私钥、认证头和常见连接字符串。
- 用户明确配置的个人敏感模式。

不复制完整 session。Git 只保存脱敏后的必要证据片段、来源 ID、源路径和内容哈希。

### 消化流水线

```text
扫描 session
→ 增量解析
→ 预脱敏
→ MemoryExtractorAgent
→ FTS 查找相关记忆
→ MemoryConsolidatorAgent
→ 确定性门禁
→ 生成暂存 diff
→ Schema、敏感信息和引用校验
→ 单写入队列提交 Git
→ 重建 summary 和 FTS
→ 检查 Skill 候选条件
```

session 内容、工具结果和历史 Agent 输出全部视为不可信数据。摄取 Agent 无法直接执行 session 中出现的指令。

## 5. Git Memory Tree

```text
memory/
  summary/
    MEMORY.md
    profile.md
    strategies.md
  active/
    profile/
    experiences/YYYY/MM/
    strategies/
  candidates/
    profile/
    strategies/
  evidence/
  reviews/
  skills/
    candidates/
    published/
    retired/
  audit/
```

问答路径默认只能访问 `summary/`、`active/` 和检索结果关联的必要证据。

### Markdown 契约

每条记忆的 YAML frontmatter 至少包含：

- `id`、`kind`、`status`、`schema_version`
- `title`、正文、标签
- `created_at`、`updated_at`
- `valid_from`、可选 `valid_to`
- `authority`：`user_explicit | tool_verified | inferred`
- `confidence`：`high | medium | low`
- `confidence_reason`
- `supporting_case_ids`
- `contradicting_case_ids`
- 脱敏后的 `provenance`
- `supersedes` 或 `superseded_by`
- `sensitivity`

Git HEAD 表示当前有效视图；Git 历史只用于人工审计和恢复，不提供给 LLM。

### 写入一致性

- 所有 Git 写操作进入同一个优先级队列。
- Agent 只生成拟议变更，不直接操作仓库。
- TypeScript 在隔离暂存区构建和验证 diff。
- 提交前验证 expected HEAD，防止基于旧状态提交。
- Git commit 记录 job ID、来源 session 和内容哈希。
- Git 已提交但 SQLite 更新失败时，启动后根据 commit metadata 自动对账。

## 6. 记忆门禁

### 经历

一次有效的用户陈述或可验证工具结果即可写入 active memory。

### 用户画像与策略

- 用户明确要求时直接晋升为 active。
- 模型推断的画像或策略，必须得到至少两个独立 case 支持、模型置信为 high，且不存在未解决冲突，才能自动晋升。
- 冲突、低置信、敏感或证据不足时进入 candidates/reviews。
- 用户消息和可验证工具结果可以作为事实证据。
- Agent 自己的回答只能形成策略候选，不能证明用户画像或经历。

### 修正类型

- `correction`：修正错误内容并替换当前有效版本。
- `temporal_change`：关闭旧条目有效期，创建当前版本。
- `forget`：从 active view 移除，但不承诺擦除 Git 历史。
- `conflict_resolution`：选择、合并或保留冲突观点。

修正流程：

```text
自然语言修正
→ 定位相关记忆
→ 生成 diff 和影响说明
→ 用户确认
→ expected HEAD 校验
→ Git commit
→ summary 和 FTS 更新
```

## 7. 检索与问答

使用渐进式上下文加载：

1. 加载小型 `MEMORY.md`。
2. SQLite FTS5 根据问题检索 profile、experience 和 strategy 候选。
3. 模型进行相关性筛选。
4. 只加载选中的 Markdown 条目和必要证据。
5. MemoryQueryAgent 生成带 memory ID 的回答。

第一版不使用 embedding 或向量数据库。FTS 是 Git HEAD 的派生投影，可以随时重建。

## 8. Skill 生命周期

候选 Skill 必须满足：

- 至少三个独立成功 case。
- 至少两个不同任务特征。
- 具有明确适用条件、输入、输出、步骤和限制。
- 引用支撑策略及案例。
- 不包含秘密、绝对本机路径或未声明工具依赖。
- 仅支持 Markdown 指南和 Prompt/工具 Schema，不生成可执行代码。

状态流：

```text
candidate → approved → published → installed
         ↘ rejected

published → retired / rollback
```

发布规则：

- Skill 可以自动生成候选。
- 发布必须由用户批准。
- 不运行语义质量评测或强制试运行。
- 只进行格式、字段、来源案例、敏感信息和安装冲突检查。
- 批准后先提交到 Git，再由确定性安装器复制到 Codex skills 目录。
- 不覆盖非 Aquarius 管理的同名 Skill。
- SQLite 记录源 commit、安装路径和文件哈希，支持回滚。

## 9. 本地服务和公共接口

Fastify 只监听 `127.0.0.1`，所有 API 使用本地 bearer token。

### HTTP API

- `POST /v1/query`
- `GET /v1/memories`
- `GET /v1/memories/{id}`
- `POST /v1/corrections/preview`
- `POST /v1/corrections/{reviewId}/confirm`
- `POST /v1/ingestions`
- `GET /v1/jobs/{jobId}`
- `GET /v1/reviews`
- `POST /v1/skills/{id}/approve`
- `POST /v1/skills/{id}/reject`
- `POST /v1/skills/{id}/rollback`
- `POST /v1/index/rebuild`
- `GET /health`

所有确认型写接口必须携带 `expectedHead`。

### CLI

- `ask`
- `memory list`
- `memory show`
- `memory correct`
- `ingest run`
- `ingest status`
- `review list`
- `skill approve`
- `skill reject`
- `skill rollback`
- `index rebuild`
- `doctor`

CLI 通过本地 API 工作，不复制业务逻辑。

## 10. SQLite 运行状态

SQLite 保存：

- source cursor 和 session/event 去重信息。
- ingestion job、执行状态、错误和重试。
- correction review 与 approval。
- Git commit/job 映射。
- Skill 发布和安装记录。
- FTS5 memory projection。
- 调度器的上次成功运行时间。
- 本地 API token metadata。

任务最多自动重试三次。数据库损坏时可从 Git 重建 FTS 和发布投影，但不能仅靠 SQLite 恢复 canonical memory。

## 11. 调度与运行

- launchd 负责启动和重启本地服务。
- 服务启动时检查最近一次成功的每日消化任务。
- 如果错过 03:00，立即创建一次 catch-up job。
- 每个自然日最多一个自动批次，手动触发除外。
- 手动任务和修正任务优先于后台整理任务。
- 每个 session、批次和 Agent run 都设置资源预算和取消机制。
- OpenAI 远程 tracing 默认关闭；本地日志只保存脱敏摘要、延迟、token、模型版本和错误类别。

## 12. 实施顺序

1. 初始化代码仓库、独立 memory repository、项目事实源和配置系统。
2. 建立 TypeScript workspace、SQLite migrations、Fastify、CLI 和 bearer token。
3. 实现通用 adapter 契约及 Codex JSONL adapter。
4. 实现脱敏、增量读取、去重和任务恢复。
5. 使用 `@openai/agents` 实现 MemoryExtractorAgent 与 MemoryConsolidatorAgent。
6. 实现 Git memory schema、暂存验证、单写入和 summary。
7. 实现 SQLite FTS 和 MemoryQueryAgent。
8. 实现修正预览、确认、冲突和时间变化。
9. 实现 SkillSynthesizerAgent、批准、安装和回滚。
10. 接入 03:00 调度、启动补跑、launchd 和健康检查。
11. 完成故障恢复、安全测试和端到端验收。

具体执行以 `issues/` 下的垂直切片 tickets 及其 blocking edges 为准。

## 13. 测试与验收

- 正常、截断、未知事件和不同版本 Codex JSONL 均可安全处理。
- session 内容追加或移动到 archived 后不会重复生成记忆。
- 敏感信息在模型调用和 Git commit 前已被替换。
- 同一根线程不会重复增加独立 case 数。
- 经历可由单次有效证据写入。
- 画像和策略在两个独立 case 后按门禁晋升。
- 冲突内容不会自动覆盖 active memory。
- Skill 在第三个有效 case 后生成候选，未经批准无法发布。
- Agent 无法直接写 Git 或安装 Skill。
- 修正取消时无 Git 改动；HEAD 变化时拒绝旧确认。
- 问答只使用当前 active memory，并提供 memory ID。
- SQLite 删除后可重建 FTS。
- Git 提交与数据库状态不一致时可以自动对账。
- 错过定时任务后能够补跑，同一天不会重复自动执行。
- 无 token、错误 token和非 localhost 请求被拒绝。
- Skill 安装不会覆盖外部目录，且可以回滚。
- 单元测试使用 Agents SDK 测试替身；真实 API smoke test 单独运行。
- Skill 发布不包含模型质量评测，只执行用户批准和静态检查。

## 14. 首版不做

- 多用户、云端部署、Web UI 和 Postgres。
- Codex 之外的真实 session adapter。
- 向量检索和 embedding。
- 完整原始 session 复制归档。
- SDK beta Memory 直接写 canonical repository。
- Skill 自动发布、可执行代码 Skill 或自动授权工具。
- Git 历史级敏感信息自动擦除。
- 多模型路由、自动升级模型或永久推理循环。

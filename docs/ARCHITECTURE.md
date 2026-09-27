# ARCHITECTURE — 架构、目录结构与数据组织

## 1. 全貌

```text
                    ┌──────────────── 你（CLI / curl）────────────────┐
                    │  Authorization: Bearer <本地 token>            │
                    ▼                                                │
        ┌───────────────────────────┐                                │
        │ packages/server (Fastify) │  只监听 127.0.0.1               │
        │  路由 / 鉴权 / 调度器      │                                │
        └────────────┬──────────────┘                                │
                     ▼                                               │
        ┌────────────────────────────────────────────┐               │
        │ packages/core  (AquariusService 组合根)     │               │
        │                                             │               │
        │  摄取流水线        问答链路      写入链路    │               │
        │  ──────────        ────────      ────────   │               │
        │  适配器 → 脱敏      摘要 → FTS    门禁 → 暂存 │               │
        │  → 提取 Agent       → 选择 Agent  → CAS 提交 │               │
        │  → 合并 Agent       → 回答 Agent  → 重建投影 │               │
        │  → 门禁 → 提交                               │               │
        └───────┬───────────────────────┬─────────────┘               │
                ▼                       ▼                             │
      ┌──────────────────┐    ┌──────────────────┐                    │
      │ Git 记忆仓库      │    │ SQLite 运行状态   │                    │
      │ canonical memory │    │ + 可重建投影      │                    │
      │ （唯一事实源）    │    │ （可删除）        │                    │
      └──────────────────┘    └──────────────────┘                    │
                ▲                                                      │
                └── 模型只能通过 Agent 返回结构化建议，永远拿不到句柄 ──┘
```

关键点：**模型不在写入路径上拥有任何权限**。Agent 是纯函数式的提议者，能不能落盘由 `gates/` 决定，怎么落盘由 `git/` 决定。

## 2. 包结构与职责

### 2.1 `packages/core`（领域层）

| 目录 | 职责 | 关键文件 |
| --- | --- | --- |
| `config.ts` | 配置解析与校验；缺项产生可执行错误 | `loadConfig` / `requireUsableConfig` / `assertMemoryRepoUsable` |
| `errors.ts` | 错误分类：code + httpStatus + actionable | `AquariusError` / `StaleHeadError` |
| `util/` | 无领域知识的基础件 | `time.ts`（IANA 时区换算）、`mutex.ts`（单写入者）、`logger.ts`（脱敏日志） |
| `db/` | SQLite 迁移与各 store | `migrations.ts`、`sessionStore`、`jobStore`、`reviewStore`、`projectionStore`、`commitStore` |
| `git/` | 原生 Git 窄封装 | `git.ts`（唯一 shell 出口）、`memoryStore.ts`（暂存、CAS 提交、日志读取） |
| `memory/` | 记忆契约与读模型 | `schema.ts`（zod 契约）、`frontmatter.ts`（解析/序列化）、`paths.ts`（树布局即权限）、`summary.ts` |
| `security/` | 确定性密钥检测与会话预清洗 | `redact.ts`、`sanitizeSession.ts` |
| `sources/` | 会话来源契约与 Codex 实现 | `adapter.ts`、`registry.ts`、`codex/parse.ts`、`codex/codexAdapter.ts` |
| `agents/` | 四个 Agent 的 I/O 契约、提示词、runtime | `contracts.ts`、`prompts.ts`、`runtime.ts`（预算包装）、`openaiRuntime.ts`、`fakeRuntime.ts`、`contradiction.ts` |
| `gates/` | 确定性门禁 | `promotion.ts`、`caseOutcome.ts`（结果有效性） |
| `pipeline/` | 摄取流水线 | `ingest.ts` |
| `query/` | FTS 文本处理与检索问答 | `ftsText.ts`（bigram 增强）、`retrieval.ts` |
| `corrections/` | 修正预览与确认 | `service.ts` |
| `reviews/` | 审查决策 | `service.ts` |
| `skills/` | Skill 候选、评测、修订、发布与回滚 | `service.ts`、`evaluation.ts` |
| `jobs/` | 队列、调度、对账 | `queue.ts`、`scheduler.ts`、`reconcile.ts` |
| `service.ts` | 组合根：API/CLI 的唯一入口 | `AquariusService` |

### 2.2 `packages/server`

- `app.ts`：Fastify 实例、鉴权 hook、全部路由（薄传输层）。
- `auth.ts`：loopback 判定 + bearer token 校验（`crypto.timingSafeEqual` 语义的定长比较）。
- `bootstrap.ts` / `main.ts`：装配服务、bootstrap（对账 + 补跑 + 安装校验）、启动队列与调度器、优雅退出。

### 2.3 `packages/cli`

- `client.ts`：从 flag/env/配置文件解析 base URL 与 token，调用本地 API，把服务端错误映射成可读提示。
- `main.ts`：commander 命令树；**不含业务逻辑**。
- `output.ts`：人类可读输出（`--json` 时输出原始 JSON）。

## 3. 摄取流水线（一次会话）

```text
discover (adapter)
  → 读取 + 解析 JSONL（未知事件计数跳过）
  → 判断是否仍在写入 → 延后
  → 内容哈希 + 新事件集合 → 无变化则 unchanged
  → sanitizeSession（先脱敏）
  → extractEvidence（只取用户消息与成功工具结果，且只取新事件）
  → MemoryExtractorAgent → 结构化观测
  → FTS 检索相关记忆 → MemoryConsolidatorAgent → 拟议操作
  → 确定性门禁 + 极性冲突检查 → active / candidate / review
  → 校验（zod 契约 + 路径 + 敏感信息）→ 隔离暂存区构造候选树
  → 单写入者队列 + expectedHead CAS → 一次 commit
  → 重建 FTS 投影与 summary
  → 检查 Skill 候选条件 → 需要则入队合成任务
```

任务结果由用户随后以 `case-outcome` 明确确认，记录到 `outcomes/`，再重算 Skill 候选资格。一次成功的工具调用与普通用户消息只构成来源证据，不构成任务成功。`duplicate` 强化也须先经过晋升门禁。

一个 session 的所有产出（记忆、证据、review 文件、audit、summary）在**同一个 commit** 里，所以「HEAD 是什么状态」永远是一致的。

## 4. 数据组织

### 4.1 Git 记忆仓库（canonical）

```text
memory-repo/
  README.md
  summary/
    MEMORY.md          每次问答都加载的小摘要（有大小预算）
    profile.md         当前 active 画像
    strategies.md      当前 active 策略
  active/
    profile/<id>.md
    experiences/YYYY/MM/<id>.md
    strategies/<id>.md
  candidates/
    profile/<id>.md
    experiences/YYYY/MM/<id>.md
    strategies/<id>.md
  archive/             superseded / forgotten / retired / rejected
    profile|experiences|strategies/...
  evidence/<case_id>/<evidence_id>.md
  reviews/<review_id>.md
  skills/{candidates,published,retired}/<skill_id>.md
  audit/<YYYY-MM-DD>/<job_id>.md
```

记忆文件 = Markdown 正文 + YAML frontmatter。frontmatter 契约（`memory/schema.ts`，zod 校验）至少包含：

```yaml
id: exp_01M340...            # 类型前缀 + ULID
kind: experience             # experience | profile | strategy | skill
status: active               # active | candidate | superseded | forgotten | retired | rejected
schema_version: 1
title: ...
tags: [...]
created_at: <ISO>            # 全部时间为 UTC ISO 字符串
updated_at: <ISO>
valid_from: <ISO|null>
valid_to: <ISO|null>         # 只有关闭有效期时才出现
authority: user_explicit     # user_explicit | tool_verified | inferred
confidence: high             # high | medium | low
confidence_reason: ...
supporting_case_ids: [...]
contradicting_case_ids: [...]
provenance:                  # 已脱敏
  source: codex
  adapter: codex-jsonl
  session_id: ...
  root_thread_id: ...
  source_path: ...
  content_hash: ...
  event_ids: [...]
  case_id: ...
sensitivity: public          # public | personal | sensitive
supersedes: [...]            # 与 superseded_by 一起表达版本关系
superseded_by: <id|null>
review_flags: [...]          # 非空 = 异常待审，不可发布
keywords: [...]
skill: {...}                 # 仅 kind=skill
skill_version: 2             # 发布版单调递增，回滚也产生新版本
revises_skill_id: skl_...    # 仅修订候选；指向稳定发布 ID
base_commit_sha: ...         # 修订候选创建时的基线仓库提交
base_content_hash: ...       # 基线发布内容哈希
```

校验规则（超出字段类型的部分）：

- `schema_version` 必须匹配当前版本；不匹配即拒绝写入。
- `status=superseded` 必须带 `superseded_by`。
- `active` 不允许带已关闭的 `valid_to`（关闭有效期必须改状态）。
- `inferred` + `high` 必须至少引用一个支撑 case。
- `kind=skill` 必须有 `skill` 块；非 skill 不允许有。
- 修订候选必须同时记录目标 Skill ID、基线提交和内容哈希。

`outcomes/<case>/<outcome>.json` 保存显式任务结果、证据与来源事件 ID、任务特征及修正关系；`evaluations/suites/<strategy>.json` 固定独立任务集；`evaluations/reports/<report>.json` 保存候选/基线哈希、模型、预算、逐场景结果及门禁结论。三者由 `MemoryRepository.snapshot()` 校验，均不会进入问答可读目录。

### 4.2 commit 契约

```text
Digest session 01a06695: 1 memory change(s)

Job: job_01M340TKYSAA3FF7752FC54E5C
Session: 01a06695-d972-7e51-af7a-15335b87c9fb (root thread 01a06695-...)
Memories written: 1
Reviews opened: 0

Aquarius-Job: job_01M340TKYSAA3FF7752FC54E5C
Aquarius-Session: 01a06695-d972-7e51-af7a-15335b87c9fb
Aquarius-Source-Hash: 260ab3f86f2422...   # 源会话内容哈希
Aquarius-Kind: ingestion                  # ingestion | correction | review-decision | skill-* | bootstrap
```

trailer 是启动对账的唯一依据：Git 提交成功但 SQLite 未更新时，靠 `Aquarius-Job` 把两边对齐。

### 4.3 SQLite（可重建）

| 表 | 内容 | 可重建？ |
| --- | --- | --- |
| `schema_migrations` | 迁移版本 | — |
| `sessions` / `session_links` / `events` | 摄取 checkpoint、去重、根线程归并 | 否（但重建代价是重新扫一遍源文件） |
| `cases` / `case_evidence` | case 计数与证据索引 | 部分（证据正文在 Git） |
| `case_outcomes` | `outcomes/` 的查询投影 | **是**（从 Git HEAD 重建） |
| `jobs` | 任务、重试、commit 映射 | 否（运行状态） |
| `git_commits` | Git ↔ 任务台账 | 是（从 `git log` 重建） |
| `reviews` | 预览、审查决定与审批 | 部分（review 文件在 Git） |
| `memory_index` / `memory_fts` | 检索投影 | **是**（从 Git HEAD 重建） |
| `skill_publications` | 发布版本、安装路径与哈希 | 是（版本从 Git frontmatter，安装状态从受管文件重建） |
| `scheduler_state` | 上次自动批次的自然日 | 否（运行状态） |
| `api_tokens` | token 元数据（只存哈希） | 否（凭据来自配置文件） |

「可重建」的含义：删除数据库后，记忆内容与检索能力可完整恢复；丢失的是运行历史（哪些任务跑过、重试了几次），不影响记忆本身。

### 4.4 三个标识族

| 标识 | 形态 | 稳定性 |
| --- | --- | --- |
| `session_id` / `event_id` / `root_thread_id` | 来源（Codex）提供 | 来源稳定；续聊通过 `parent_thread_id`/`forked_from_id` 归并到根线程 |
| `case_id` | `case_<ULID>` | 每个根线程一个，永久不变 |
| `evidence_id` | `ev_<sha256 派生>` | **内容派生**，同一事件永远同一个 ID（幂等的基础） |
| `outcome_id` | `out_<sha256 派生>` | 同一次确认重复提交不生成第二条结果；修正追加新 ID |
| 记忆 ID | `exp_/pro_/str_/skl_ + ULID` | 创建时确定，跨状态变更保持不变 |
| review 候选 ID | `cnd_<sha256 派生>` | 内容派生，重复运行复用同一候选文件 |

## 5. 并发与一致性

- **单写入者**：所有 ref 移动经同一队列；`AsyncMutex` 只包住 `MemoryStore.commit`，Agent 调用与解析在锁外，因此长批次不会卡住用户的修正。
- **优先级**：user(10) > manual(20) > post_ingest(30) > background(40)。后台批次在两次会话之间检查是否有更高优先级任务，有则让位并把自己剩下的工作排成续跑任务。
- **CAS 提交**：`update-ref <ref> <new> <expected>` 原子比较交换；不匹配即 `stale_head`。
- **脏工作区保护**：拒绝覆盖不是 Aquarius 写的工作区改动。
- **启动对账**：`reconcileFromGit()` 补台账、修任务、重建投影，幂等。

## 6. 扩展点

| 想加什么 | 改哪里 | 不需要改什么 |
| --- | --- | --- |
| 新的会话来源（Claude Code 等） | 实现 `SessionSourceAdapter`，注册进 `AdapterRegistry` | 流水线、门禁、检索、存储 |
| 新的记忆类型 | `memory/schema.ts` 的 enum + `paths.ts` 的布局 + 门禁规则 | 存储与提交机制 |
| 换模型、端点或预算 | 配置项（`AQUARIUS_MODEL`、`AQUARIUS_MODEL_BASE_URL`、`budgets`） | Agent 契约 |
| 调整晋升/发布规则 | `gates/promotion.ts` + 对应测试 | Agent 提示词 |
| 换检索实现 | `ProjectionStore` + `RetrievalService` | 记忆契约与 Git 层 |
| 只读 Web UI | 新增 `packages/web`，复用 HTTP API | 领域层（不要复制业务逻辑） |

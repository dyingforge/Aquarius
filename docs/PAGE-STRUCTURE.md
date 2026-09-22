# PAGE-STRUCTURE — 对外界面结构

原文档树此处注释为「网站页面和组件详情页结构说明」。Aquarius 首版没有网站，对外界面是 **CLI 命令**、**HTTP 路由**与**记忆树布局**三者。本文件是它们的结构说明：每一层对外暴露什么、返回值结构如何、错误如何表达。

三者共享同一份契约：CLI 只是 HTTP 的展示层，HTTP 只是 `AquariusService` 的传输层，因此同一个问题的返回结构在三处完全一致（有测试逐字节比对 HTTP 与 service 的返回）。

## 1. CLI 结构

```text
aquarius [全局选项] <命令> [子命令] [参数] [选项]

全局选项
  --json               输出原始 JSON（脚本用）
  --url <url>          覆盖服务地址
  --token <token>      覆盖本地 token
```

### 1.1 命令树

| 命令 | 参数/选项 | 作用 | 是否写 Git |
| --- | --- | --- | --- |
| `doctor` | — | 自检全部依赖并给出可执行建议 | 否 |
| `config` | — | 打印生效配置（永不打印密钥） | 否 |
| `ask <question>` | `--limit <n>` | 用当前有效记忆回答并给出 memory ID | 否 |
| `memory list` | `--kind --status --limit` | 列出 HEAD 上的记忆 | 否 |
| `memory show <memoryId>` | — | 单条记忆 + 来源 + 证据 | 否 |
| `memory correct "<自然语言>"` | `--yes --preview-only` | 预览 →（确认）→ 提交修正 | 确认时 |
| `ingest run` | `--session <id\|path> --force` | 消化一个新会话或整批 | 是 |
| `ingest status` | — | 调度状态、会话计数、最近任务 | 否 |
| `review list` | `--status --type` | 列出审查项 | 否 |
| `review show <reviewId>` | — | 候选/目标内容、支撑与反对证据、置信理由 | 否 |
| `review resolve <reviewId>` | `--decision --note --merged-body --merged-title --dry-run --yes` | 先显示最终 diff，再应用决定 | 应用时 |
| `index rebuild` | — | 从 Git HEAD 重建 FTS 投影 | 否（只改 SQLite） |
| `skill list` | — | 候选/已发布 Skill 与安装状态 | 否 |
| `skill show <skillId>` | — | Skill 全文、关联策略与案例、安装目标、同名冲突 | 否 |
| `skill approve <skillId>` | `--yes --note` | 发布并安装（先写 Git，再安装） | 是 |
| `skill reject <skillId>` | `--reason` | 拒绝候选 | 是 |
| `skill rollback <skillId>` | `--yes` | 回滚到上一已发布并安装的版本 | 是 |
| `skill retire <skillId>` | `--yes` | 退场并移除受管安装 | 是 |

`--decision` 可选值：`adopt`、`merge`、`reject`、`temporal_change`、`forget`。

### 1.2 交互约定

```text
$ aquarius memory correct "这条记错了，其实是另一个结论"

Preview rev_01M340TXXC98E86661CD64EB9B (correction) against head 0b735a72de0d

Affected memories
- exp_01M340TM0Z8B... → superseded (close) archive/experiences/2026/2026-09/exp_01M340TM0Z8B....md
- exp_01M340TXEZ3B... → active (replace) active/experiences/2026/2026-09/exp_01M340TXEZ3B....md

Diff
diff --git a/active/... b/active/...

Apply this correction? [y/N]
```

规则：

- 任何会写 Git 的命令都遵循「**预览 → 确认 → 应用**」三段式。`--preview-only` 停在第 1 步，`--dry-run`（review resolve）在第 1 步输出最终 diff。
- 非 TTY 环境没有 `--yes` 时**拒绝执行**并提示加 `--yes`，不会静默继续。
- 取消时明确说「没有修改记忆仓库」。
- 退出码见 [COMPONENT-GUIDELINES.md](COMPONENT-GUIDELINES.md) 5.1。

## 2. HTTP 路由结构

所有路由仅在 `127.0.0.1` 上可用，除 `/health` 外均需 `Authorization: Bearer <token>`。

### 2.1 只读

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/health` | 未认证：`{status, version}`；认证：完整健康报告（含索引一致性、仓库状态、无效文件列表、队列、调度） |
| GET | `/v1/doctor` | `{ok, version, checkedAt, checks[]}`，每项含 `status: ok\|warn\|fail`、`detail`、可选 `actionable` |
| GET | `/v1/config` | `{config, issues}`；密钥替换为 `hasApiToken` / `hasOpenAiApiKey` 布尔 |
| GET | `/v1/memories?kind&status&limit` | `{memories[], counts, head}` |
| GET | `/v1/memories/:memoryId` | 记忆全文 + frontmatter + 证据清单；不存在 → 404 |
| GET | `/v1/reviews?status&type&limit` | `{reviews[]}` |
| GET | `/v1/reviews/:reviewId` | 候选、目标、支撑证据、反对证据、置信理由、门禁理由 |
| GET | `/v1/jobs?status&kind&limit` · `/v1/jobs/:jobId` | 任务记录（状态、尝试次数、commit、错误码） |
| GET | `/v1/ingestions/status` | 调度状态、会话计数、最近任务、case 数、HEAD |
| GET | `/v1/skills` · `/v1/skills/:skillId` | Skill 列表 / 详情（含安装状态与同名冲突） |

### 2.2 写入

| 方法 | 路径 | body 必需字段 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/query` | `question`（可选 `limit`） | 问答；返回结构见下 |
| POST | `/v1/ingestions` | 可选 `sessionId`、`force` | 单会话或整批摄取；立即执行并返回任务结果 |
| POST | `/v1/corrections/preview` | `instruction` | 返回 `{reviewId, type, baseHead, memoryIds, affected[], diff, notes[], expiresAt}`；**不写 Git** |
| POST | `/v1/corrections/:reviewId/confirm` | `expectedHead` | 应用预览；HEAD 不匹配 → 409 `stale_head` |
| POST | `/v1/reviews/:reviewId/resolve` | `decision`、`expectedHead`；可选 `dryRun`、`note`、`mergedBody`、`mergedTitle` | `dryRun` 只返回 diff；应用后同一 review 不可重复执行 |
| POST | `/v1/skills/:skillId/approve` | `expectedHead`、`approvedBy` | 静态门禁 → Git published → 安装 |
| POST | `/v1/skills/:skillId/reject` | `expectedHead`、`reason` | 拒绝候选 |
| POST | `/v1/skills/:skillId/rollback` | `expectedHead` | 回滚到上一已发布版本并重装 |
| POST | `/v1/skills/:skillId/retire` | `expectedHead` | 退场并移除受管安装 |
| POST | `/v1/index/rebuild` | — | 从 Git HEAD 重建投影 |

### 2.3 问答返回契约

`POST /v1/query` 与 `AquariusService.query()` 返回同一结构（测试逐字节比对）：

```json
{
  "question": "依赖管理用什么",
  "answer": "Based on current active memory:\n- ...",
  "memoryIds": ["exp_01M340..."],
  "citations": [
    { "memoryId": "exp_01M340...", "kind": "experience", "title": "...",
      "path": "active/experiences/2026/2026-09/....md",
      "authority": "user_explicit", "confidence": "high", "cases": ["case_..."] }
  ],
  "uncertainty": "none",
  "insufficientEvidence": false,
  "reason": "Answered from 1 active memory record(s).",
  "notices": [],
  "head": "67055e94a047...",
  "runtime": "fake",
  "retrieved": 6
}
```

- `memoryIds` 只包含**真实存在且被使用**的 active 记忆；证据不足时为空且 `insufficientEvidence` 为 true。
- `runtime` 明确标注是 `openai` 还是 `fake`，避免把干跑结果当成真实模型输出。

### 2.4 错误结构

所有非 2xx 返回统一为：

```json
{ "error": { "code": "stale_head", "message": "...", "actionable": "...", "details": {} } }
```

状态码映射（`errors.ts`）：401 `unauthorized`、403 `forbidden`、404 `not_found`、409 `stale_head`/`conflict`/`review_expired`/`review_already_resolved`/`skill_install_conflict`/`memory_repo_dirty`、422 `validation_failed`、500 内部错误、501 `not_implemented`、503 `source_unavailable`、504 `agent_budget_exceeded`。

## 3. 记忆树布局（数据界面）

记忆仓库本身就是给人看的界面（`git log`、编辑器、`cat`）。布局即权限：

```text
memory-repo/
├── README.md                       仓库说明
├── summary/
│   ├── MEMORY.md                   每次问答加载的小摘要（计数 + 高价值条目）
│   ├── profile.md                  当前 active 画像
│   └── strategies.md               当前 active 策略
├── active/                         ← 问答可读
│   ├── profile/<id>.md
│   ├── experiences/YYYY/MM/<id>.md
│   └── strategies/<id>.md
├── candidates/                     未晋升 / 待审（问答不可读）
├── archive/                        已移出视图（问答不可读）
├── evidence/<case_id>/<evidence_id>.md
├── reviews/<review_id>.md          审查留痕
├── skills/{candidates,published,retired}/<skill_id>.md
└── audit/YYYY-MM-DD/<job_id>.md    每次摄取的运行记录
```

浏览约定：

- 每条记忆的 frontmatter 是「详情页」：`status` 说明是否当前有效，`confidence_reason` 说明为什么可信，`supporting_case_ids` 与 `provenance.event_ids` 指向证据，`supersedes`/`superseded_by` 说明版本关系。
- `audit/` 是「运行日志页」：本次消化写了什么、跳过了哪些事件类型、触发了哪些脱敏规则；**不含会话原文与凭据**。
- `reviews/` 是「待办页」：review 文件在决定前一直是 `pending`，决定后在 SQLite 里记录审批人与时间。

## 4. 新增命令或路由的检查清单

- [ ] 只读与写入分离；写入命令走「预览 → 确认 → 应用」。
- [ ] 写入必须携带 `expectedHead`（若基于先前读取的状态）。
- [ ] 返回结构在 service 层定义一次，HTTP 与 CLI 都复用它。
- [ ] 错误用 `AquariusError`，带 `actionable` 与正确状态码。
- [ ] CLI 同时支持默认输出与 `--json`。
- [ ] 在 [README.md](../README.md) 命令表与 [DEVELOPMENT.md](DEVELOPMENT.md) 中登记。

# AGENTS.md — 项目协作与代码开发规范

本文件是 Aquarius 的**协作契约**：无论是人还是 AI 协作者，改这个仓库之前先读这里。目标是让任何人都能放心地在不破坏不变量（见 [DESIGN.md](DESIGN.md)）的前提下提交改动。

## 1. 基本规则

- 语言：文档与注释用中文；代码标识符、日志字段、Git 提交信息用英文。
- 注释只解释**读代码看不出来的约束**（为什么不这么做、外部格式的坑），不复述代码在做什么。
- 不引入新依赖除非确有必要。当前依赖清单刻意很短：`@openai/agents`、`zod`、`yaml`、`fastify`、`commander`。加依赖前先问「标准库或已有依赖能否做到」。
- 不提交运行时状态：`~/.aquarius/`、`*.db`、日志、`dist/`、`node_modules/` 都在 `.gitignore` 里。**记忆仓库永远不在应用仓库内部**（配置层会直接拒绝这种布局）。

## 2. 代码组织

```text
packages/core/src/
  config.ts            配置加载与校验（缺什么就给可执行的报错）
  errors.ts            错误分类：code + httpStatus + actionable
  util/                ids、时间（含时区）、日志、文件、互斥锁
  db/                  SQLite：migrations + 各 store（sessions/jobs/reviews/projection/commits）
  git/                 原生 Git 窄封装 + 记忆仓库（暂存、CAS 提交、日志读取）
  memory/              记忆契约（schema/frontmatter/paths）、读模型、summary
  security/            确定性脱敏 + 会话预清洗
  sources/             适配器契约 + Codex JSONL 适配器
  agents/              四个 Agent 的 I/O 契约、提示词、runtime（真实 + 确定性替身）
  gates/               确定性门禁：谁能进入当前视图
  pipeline/            摄取流水线（解析 → 脱敏 → 提取 → 合并 → 门禁 → 提交 → 重建投影）
  query/               FTS 文本处理、渐进式检索与问答
  corrections/         修正预览与确认
  reviews/             冲突/候选的审查与决策
  skills/              Skill 候选、静态发布校验、确定性安装与回滚
  jobs/                单写入者任务队列、调度器、启动对账
  service.ts           组合根：所有能力的唯一入口
  test/                测试与 harness（`@aquarius/core/testing`）
```

分层规则：

- `packages/server` 与 `packages/cli` **不包含业务逻辑**，只做传输与展示，一律通过 `AquariusService` / HTTP API。
- `core` 内部依赖方向单向：`util → db/git/memory/security/sources → agents/gates/pipeline/query/corrections/reviews/skills → jobs → service`。不允许反向依赖。
- Agent 永远拿不到 Git 句柄、shell 或文件路径；它们只返回经 zod 校验的结构化建议。

## 3. 必须遵守的工程约束

1. **模型只提议，TypeScript 决定。** 任何写入当前视图的判定都必须落在 `gates/` 的纯函数里，且能被单元测试直接调用。不要把门禁逻辑塞进提示词。
2. **先脱敏，后外发。** 任何进入模型调用、日志或 Git 的文本，必须先过 `security/redact.ts`。新增日志字段时问一句：这里会不会带出会话原文或凭据？
3. **Git 是事实源。** SQLite 里只放可以重建的东西。任何时候删掉 `aquarius.db`，`aquarius index rebuild` 之后系统必须恢复成一样的样子。
4. **所有 Git 写入只有一个入口。** 提交走 `MemoryStore.commit`（隔离暂存 + `expectedHead` CAS），并且只在实际移动 ref 的那一小段持有 `AsyncMutex`。不要在别处 `git commit`。
5. **确认型写入必须携带 `expectedHead`。** 取消预览、HEAD 变化、重复确认都必须是无副作用或明确报错。
6. **幂等。** 同一个 session、同一个 event、同一次确认，重复执行不得产生第二条记忆或第二次有效提交。测试里有专门断言。
7. **失败要可执行。** 抛错用 `AquariusError`，带上 `actionable`：告诉用户下一步该做什么，而不是只说失败了。

## 4. 测试规范

- 框架：`node --test`（内置）。测试文件与被测代码同目录，命名 `*.test.ts`。
- 每个测试用 `createEnvironment()`（来自 `@aquarius/core/testing`）拿到隔离的临时 home、独立记忆仓库与 Codex 源目录，结束时 `env.cleanup()`。
- 默认使用 `FakeAgentRuntime`（确定性替身），保证测试不发网络请求、不需要 API key。真实 Agents SDK 只做可选 smoke test。
- 测试要断言**可观察的外部行为**：Git 里的文件内容、commit trailer、API 响应、拒绝的错误码。不要断言内部实现细节。
- 每条不变量至少有一个测试，尤其是：过期 HEAD 被拒绝、脏工作区被拒绝、冲突不进当前视图、凭据不入库、重复摄取不产生新提交、索引可重建。
- 修 bug 时先写一个能复现的失败测试，再修。

```bash
pnpm typecheck          # tsc -b，全仓类型检查
pnpm test               # 全部测试
pnpm test:core          # 只跑 core（串行，便于定位）
```

## 5. 提交信息

采用 Conventional Commits 风格，主题行祈使句、英文、不超过 72 字符：

```text
feat(gates): require two independent cases before promoting an inferred strategy
fix(git): keep multi-line commit bodies intact when reading trailers
docs(architecture): document the single-writer commit path
test(skills): cover install conflicts with non-Aquarius skills
```

正文说明**为什么**改（约束、失败现象），而不是复述 diff。涉及不变量变化的改动，必须在同一个提交里更新 [DESIGN.md](DESIGN.md)。

## 6. 变更检查清单

提交前逐条确认：

- [ ] `pnpm typecheck` 与 `pnpm test` 全绿。
- [ ] 新增/修改的行为有对应测试；修的 bug 有回归测试。
- [ ] 没有把会话原文、凭据、绝对本机路径写进日志、测试夹具或 Git。
- [ ] 涉及记忆契约（frontmatter 字段、状态流转）时同步更新 `docs/ARCHITECTURE.md` 与 `docs/REGISTRY.md`。
- [ ] 涉及不变量时同步更新 `DESIGN.md`，并在 `CHANGELOG.md` 记录。
- [ ] 没有顺手重排无关代码的格式。

## 7. 不要做的事

- 不要让 Agent 直接写 Git 或安装 Skill。
- 不要把 SDK 的 beta Memory 当作 canonical memory。
- 不要为了「更智能」把确定性门禁换成模型判断。
- 不要在应用仓库里初始化记忆仓库。
- 不要把向量检索/embedding 混进首版（FTS 是刻意选择，见 DESIGN.md）。

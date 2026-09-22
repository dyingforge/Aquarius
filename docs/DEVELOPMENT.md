# DEVELOPMENT — 开发与组件发布流程

## 1. 环境准备

```bash
# 前置：Node.js ≥ 24.10（需要内置 node:sqlite 与原生 TS 执行）、Git、pnpm
node -v            # v24.10.0 或更高
git --version
pnpm -v

pnpm install
pnpm typecheck     # tsc -b，全仓类型检查
pnpm test          # 85 个测试
```

本项目**不需要构建步骤**即可开发：Node 24 直接执行 `.ts`（类型擦除），`tsc -b` 用于类型检查与产出 `dist/`。测试与源码同目录，`node --test` 直接跑 `.ts`。

### 1.1 两种运行模式

| 模式 | 配置 | 行为 |
| --- | --- | --- |
| 干跑（默认用于开发/测试） | `AQUARIUS_AGENT_RUNTIME=fake` | 用确定性替身产生 Agent 输出；不发网络请求、不需要 API key；所有记录标 `runtime: "fake"` |
| 真实 | `AQUARIUS_AGENT_RUNTIME=openai` + `OPENAI_API_KEY` | 通过 `@openai/agents` 调用模型；需要 key，缺 key 时**拒绝启动**而不是半可用 |

`doctor` 会明确报告当前模式，避免把干跑结果误当成模型输出。

### 1.2 本地起一个开发实例

```bash
export AQUARIUS_HOME=/tmp/aquarius-dev          # 别用真实 home，避免污染真实记忆
export AQUARIUS_AGENT_RUNTIME=fake
export AQUARIUS_PORT=8799
pnpm server                                     # 终端 A

export AQUARIUS_HOME=/tmp/aquarius-dev AQUARIUS_PORT=8799
pnpm cli doctor                                 # 终端 B
pnpm cli ingest run --session <sessionId|path>
pnpm cli ask "这个项目用什么包管理器"
```

常用调试开关：

| 变量 | 作用 |
| --- | --- |
| `AQUARIUS_AGENT_RUNTIME=fake` | 用确定性替身 |
| `AQUARIUS_SCHEDULE_ENABLED=false` | 关掉每日自动批次与补跑（调试单会话时很有用） |
| `AQUARIUS_ACTIVE_SESSION_QUIET_SECONDS=0` | 不再延后处理「仍在写入」的会话（测试常用） |
| `AQUARIUS_LOG_LEVEL=debug` | 更详细的脱敏日志 |
| `AQUARIUS_MODEL=<id>` | 覆盖模型快照 |
| `AQUARIUS_REDACTION_PATTERNS='p1;;p2'` | 追加自定义脱敏正则（`;;` 分隔） |
| `AQUARIUS_CODEX_SESSIONS_DIR` / `_ARCHIVED_DIR` / `_SESSION_INDEX` | 指向夹具目录，而不是真实 Codex 目录 |

## 2. 日常开发循环

1. **先读约束**：[DESIGN.md](../DESIGN.md) 的不变量决定了很多看起来「可以更简单」的做法其实不行。
2. **先写测试**：修 bug 先写复现测试；加能力先写验收测试（ticket 的验收条目就是测试清单）。
3. **改代码**，保持模块边界与依赖方向（见 [COMPONENT-GUIDELINES.md](COMPONENT-GUIDELINES.md)）。
4. **跑测试**：

```bash
pnpm test                                        # 全部
pnpm test:core                                   # 只跑 core（串行，好定位）
node --test "packages/core/src/test/ingest.test.ts"   # 单个文件
```

5. **更新文档**：契约/不变量变化同步 `ARCHITECTURE.md`、`REGISTRY.md`、`DESIGN.md`；用户可见行为变化记 `CHANGELOG.md`；进度变化更新 `TODO.md`。

### 2.1 测试数据

- 用 `createEnvironment()`（`@aquarius/core/testing`）拿隔离环境；它返回 `{config, service, memoryRepoPath, codexSessionsDir, ...}`，结束时 `env.cleanup()`。
- 用 `writeCodexSession()` 造会话夹具；它生成与真实 Codex 记录同构的 JSONL（含 `session_meta`、`turn_context`、`response_item/*`、`event_msg/*`），并支持 `extraLines`（未知事件）、`truncateTail`（写入中）、`parentThreadId`（续聊归并）等场景。
- 造完夹具记得 `ageFile(path)`，否则「仍在写入」的延后逻辑会拦下它。
- 需要「服务已经在跑」的场景，用 `buildApp({service})` + `app.listen({port: 0})`（见 `packages/server/src/app.test.ts`）。

### 2.2 断言什么

断言**外部可观察行为**：Git 里的文件与 commit trailer、HTTP 响应、SQLite 状态、抛出的错误码。不要断言内部函数调用次数或私有方法。

几条必须有的断言（改相关代码时看一眼）：

- 重复摄取 → HEAD 不变、记忆数不变、commit 数不变。
- 预览/取消 → 仓库与 HEAD 完全不变。
- HEAD 变化后确认 → `stale_head`。
- 冲突/敏感内容 → 不进入 `active`，出现在 review 队列。
- 凭据 → 扫描整个 Git 历史确认零命中。
- 索引删除后重建 → 可检索集合与重建前相同。
- 单会话任务 → 只摄取那一个会话（不能顺手消化别的）。

## 3. 组件/模块发布流程（内部）

「发布」在本项目有两种含义，流程不同。

### 3.1 发布代码（版本）

1. 确认 `main` 上 `pnpm typecheck && pnpm test` 全绿。
2. 更新 `CHANGELOG.md`：新版本号、日期、新增/修复/变更，修复项写清「现象 → 原因 → 影响」。
3. 若涉及记忆契约或接口契约的破坏性变更：升 `schema_version`、在 `ARCHITECTURE.md` 写迁移说明、在 `CHANGELOG.md` 顶部标注 **BREAKING**。
4. 更新 `package.json` 根版本与相关包版本（三者保持同步）。
5. 打 tag（`v0.2.0`），推送。

### 3.2 发布 Skill（运行时能力）

Skill 是**运行时数据**，不是代码，走 [REGISTRY.md](REGISTRY.md) 的流程：候选自动生成 → 静态校验 → 用户批准 → Git `published/` → 确定性安装。开发者不需要（也不能）绕过这个流程把 Skill 直接塞进 `~/.codex/skills`。

## 4. 提 PR / 提交检查清单

- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm test` 全绿；新增行为有测试，修的 bug 有回归测试。
- [ ] 没有把会话原文、凭据、本机绝对路径写进代码、测试夹具、日志或 Git。
- [ ] 契约变更已同步 `ARCHITECTURE.md` / `REGISTRY.md`；不变量变更已同步 `DESIGN.md`。
- [ ] 提交信息遵循 Conventional Commits，正文说明「为什么」，不复述 diff。
- [ ] 没有顺手重排无关代码。

## 5. 调试常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `Aquarius cannot start: ...` | 缺 API key / 仓库路径在应用仓内 / host 非 loopback | 按报错里的 `→` 逐条修；干跑用 `AQUARIUS_AGENT_RUNTIME=fake` |
| `memory_repo_dirty` | 记忆仓库有未提交改动 | 先 commit/stash；Aquarius 绝不覆盖不是自己写的工作区 |
| 摄取后 HEAD 没动 | 内容哈希未变或没有新事件 | 正常幂等行为；`ingest run --force` 会跳过延后判断但仍不会重复写同样内容 |
| 会话没被处理 | 仍在写入（默认 120s 静默期） | 等一会儿，或调 `AQUARIUS_ACTIVE_SESSION_QUIET_SECONDS=0` |
| 某个会话一直失败 | 源文件损坏或被删除 | 看 `/v1/jobs/:jobId` 的错误码；坏会话不会阻塞其他会话 |
| 提问说「证据不足」 | 检索为空或索引过期 | `aquarius index rebuild`；再确认相关记忆状态是 `active` |
| 想确认没有凭据泄漏 | — | 用脱敏器扫一遍仓库：`git ls-tree -r --name-only HEAD` 逐文件过 `Redactor.redact()`，并对 `git rev-list --objects --all` 的历史 blob 同样处理 |

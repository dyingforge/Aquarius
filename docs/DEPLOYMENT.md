# DEPLOYMENT — 构建与本机部署

原文档树此处注释为「项目构建与 Cloudflare 部署说明」。Aquarius 是**单用户本地服务**，按产品定位不会部署到 Cloudflare 或任何公网环境（见 [PROJECT-SPEC.md](PROJECT-SPEC.md)「首版不做」）。因此本文件说明的是**本机构建与常驻部署**：launchd 托管、调度语义、健康检查、升级与故障恢复。

如果你是来找「怎么把它放到云上」的：那不在项目范围内，而且服务在设计上只监听 `127.0.0.1`、只接受本机 bearer token，放到公网需要先改掉这两条不变量（不推荐）。

## 1. 构建

开发不需要构建（Node 24 直接跑 `.ts`）。产出可分发产物时：

```bash
pnpm install --frozen-lockfile
pnpm typecheck          # tsc -b，生成 dist/ 并做全仓类型检查
pnpm test               # 85 个测试
```

`tsc -b` 会把 `packages/*/src/**/*.ts` 编译到 `packages/*/dist/`（含 `.d.ts` 与 sourcemap），并把源码里的 `.ts` 导入重写为 `.js`。构建产物与源码树一一对应；本地服务**默认直接运行源码**，`dist/` 主要用于类型消费与打包场景。

## 2. 部署前检查

```bash
pnpm cli doctor
```

逐项确认（任一 `fail` 都不要上线）：

- `config`：配置可解析；`memoryRepoPath` 在应用仓库之外。
- `source:codex` 与三个路径检查：源目录真实存在，否则什么都不会被消化。
- `database`：SQLite 可打开且 schema 版本匹配。
- `memory-repository`：是 Git 仓库、分支正确、无未提交改动。
- `model` / `model:credentials`：模式与 key 符合预期（干跑模式会标 warn）。
- `auth` / `bind`：token 已注册；只绑定 loopback。
- `search-index`：索引与 Git HEAD 一致（`warn` 时执行 `aquarius index rebuild`）。
- `memory-files`：HEAD 上所有记忆文件通过契约校验。
- `skills-directory`：列出 Codex skills 目录，标明哪些受 Aquarius 管理。

## 3. 常驻部署（macOS launchd）

```bash
./scripts/install-launchd.sh
```

脚本会把 `deploy/launchd/com.aquarius.server.plist.template` 渲染成 `~/Library/LaunchAgents/com.aquarius.server.plist`（权限 0600），然后 `launchctl bootout` + `bootstrap` + `enable`。

### 3.1 为什么用 launchd，以及为什么调度不交给它

launchd 的职责只有两件：**开机拉起**、**崩溃重启**（`KeepAlive`）。

每日 03:00 的消化**不**写成 launchd 的 `StartCalendarInterval`，原因很直接：机器在 03:00 处于睡眠或关机状态时，日历触发不会补跑。Aquarius 把调度放在应用里：

- 服务启动时计算「今天 03:00（Asia/Shanghai）」是否已过、以及最近一次成功的自动批次属于哪个自然日；
- 错过了就创建一个 `catch_up` 任务；
- 每个自然日至多一个自动批次（`scheduler_state.last_auto_ingest_day` + 任务表的 `day_key` 双重保证）；
- 手动触发不受这个限制。

所以「笔记本合盖一整天，第二天打开」的结果是：启动即补跑一次，且不会重复。

### 3.2 plist 关键字段

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `ProgramArguments` | `node --disable-warning=ExperimentalWarning <repo>/packages/server/src/main.ts` | 直接跑源码；`--disable-warning` 抑制 `node:sqlite` 的实验性提示 |
| `EnvironmentVariables.AQUARIUS_HOME` | `~/.aquarius` | 配置、数据库、记忆仓库、日志都在这里 |
| `RunAtLoad` | `true` | 登录即启动 |
| `KeepAlive.SuccessfulExit=false` | — | 异常退出才重启（正常退出不拉起） |
| `ProcessType` | `Background` | 不参与前台资源竞争 |
| `StandardOutPath` / `StandardErrorPath` | `~/.aquarius/logs/*.log` | 结构化脱敏日志 |
| `ThrottleInterval` | `30` | 崩溃重启最小间隔，避免疯狂重启 |

`OPENAI_API_KEY` 不要写进 plist（plist 是明文且会被备份）。用真实模型时把 key 放进 launchd 能读到的环境变量文件，或用包装脚本注入；干跑模式则完全不需要。

### 3.3 常用运维命令

```bash
launchctl print   gui/$(id -u)/com.aquarius.server     # 查看状态
launchctl kickstart -k gui/$(id -u)/com.aquarius.server # 重启
launchctl bootout  gui/$(id -u)/com.aquarius.server     # 停止
tail -f ~/.aquarius/logs/aquarius.err.log               # 看日志（已脱敏）
curl -s http://127.0.0.1:8787/health                    # 最小健康检查（无需 token）
```

## 4. 配置

配置来自 `~/.aquarius/config.json`（首次启动生成，0600）与环境变量；环境变量优先。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AQUARIUS_HOME` | `~/.aquarius` | 配置、数据库、记忆仓库、日志的根目录 |
| `AQUARIUS_MEMORY_REPO` | `$HOME/memory-repo` | **必须**位于应用仓库之外 |
| `AQUARIUS_DB` | `$HOME/aquarius.db` | SQLite 路径 |
| `AQUARIUS_HOST` / `AQUARIUS_PORT` | `127.0.0.1` / `8787` | 只允许 loopback |
| `AQUARIUS_MODEL` | `gpt-5` | 固定模型快照 |
| `AQUARIUS_AGENT_RUNTIME` | `openai` | `openai` 或 `fake`（确定性替身） |
| `OPENAI_API_KEY` | — | `openai` 模式下必需，缺失即拒绝启动 |
| `AQUARIUS_TRACING` | `false` | 远程 tracing；默认关闭 |
| `AQUARIUS_SCHEDULE_ENABLED` / `_HOUR` / `_MINUTE` / `AQUARIUS_TIMEZONE` | `true` / `3` / `0` / `Asia/Shanghai` | 每日批次 |
| `AQUARIUS_ACTIVE_SESSION_QUIET_SECONDS` | `120` | 源文件多久没变才认为「写完了」 |
| `AQUARIUS_REDACTION_PATTERNS` | — | 追加脱敏正则，`;;` 分隔 |
| `AQUARIUS_SKILL_INSTALL_DIR` | `~/.codex/skills` | Skill 安装目标 |
| `AQUARIUS_CODEX_SESSIONS_DIR` / `_ARCHIVED_DIR` / `_SESSION_INDEX` | `~/.codex/...` | 会话来源 |

写入预算（`budgets`）：每次 Agent run 的超时、最大轮数、最大工具调用数、最大输出 token，以及单批最多消化的会话数（默认 25）。

## 5. 备份与恢复

| 想保住什么 | 怎么做 |
| --- | --- |
| 记忆（重要） | 备份记忆仓库即可：`git -C ~/.aquarius/memory-repo bundle create backup.bundle --all`（或推到一个私有远端）。这是唯一不可重建的数据。 |
| 运行状态 | 可选。`~/.aquarius/aquarius.db` 丢了只会丢「哪些任务跑过」。 |
| 凭据 | `~/.aquarius/config.json`（0600）需要时手工保管；泄露就删掉该文件重启，服务会生成新 token。 |

恢复：

```bash
# 1) 恢复记忆仓库
git clone backup.bundle ~/.aquarius/memory-repo     # 或 git clone <私有远端>

# 2) 重建可重建的一切
aquarius index rebuild
```

服务启动时会自动对账（`git log` ↔ SQLite）并重建投影，所以「先恢复仓库，再启动」就够了。

## 6. 升级

```bash
cd <aquarius-checkout>
git pull
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
launchctl kickstart -k gui/$(id -u)/com.aquarius.server
pnpm cli doctor
```

启动时会执行待应用的 SQLite migration 与一次对账；记忆仓库不需要迁移（除非 `schema_version` 升级，那时按 `CHANGELOG.md` 的说明处理）。

## 7. 故障恢复手册

| 症状 | 诊断 | 处置 |
| --- | --- | --- |
| 服务起不来，日志有可执行报错 | 缺 key / 路径非法 / 端口占用 | 按报错里的 `→` 修；端口占用换 `AQUARIUS_PORT` |
| 服务在跑但每天没消化 | `aquarius ingest status` 看调度与任务 | 确认 `AQUARIUS_SCHEDULE_ENABLED`；看是否有 `failed` 任务与错误码 |
| 索引落后于 HEAD | `aquarius doctor` 的 `search-index` warn | `aquarius index rebuild`（幂等，随时可跑） |
| `memory_repo_dirty` | 有人手改了记忆仓库 | 先 commit/stash；Aquarius 拒绝覆盖不是自己写的内容 |
| 有记忆文件校验失败 | `doctor` 的 `memory-files` warn，`/health` 的 `invalidFiles` | 修文件或删除该条目（它会同时从索引里消失，这是有意的）|
| 某个会话反复失败 | `/v1/jobs/:jobId` 的错误码与消息 | 源文件损坏就删掉它；坏会话不影响其他会话 |
| Skill 显示 `published` 但没有安装 | SQLite 里状态不是 `installed` | 修复冲突（同名非受管 Skill）后重新批准；重试幂等 |
| 数据库损坏 | 服务无法打开 SQLite | 删掉 `aquarius.db` 重启，然后 `aquarius index rebuild`；记忆不受影响 |

## 8. 上线检查清单

- [ ] `pnpm typecheck && pnpm test` 全绿。
- [ ] `aquarius doctor` 无 `fail`；`search-index` 与 `memory-files` 无 `warn`。
- [ ] 记忆仓库位于应用仓库之外，且已纳入备份。
- [ ] `OPENAI_API_KEY` 不在 plist、不在 Git、不在日志里（用环境变量或包装脚本注入）。
- [ ] 远程 tracing 保持关闭（除非明确需要，且清楚它会外发数据）。
- [ ] 试跑一次真实场景：`ingest run` → `ask` → `memory correct`（预览并取消）→ `review list`。
- [ ] launchd 已加载并验证重启行为：`launchctl kickstart -k` 后 `/health` 恢复正常。

# Aquarius

Aquarius 是一个**单用户、本地运行的长期记忆服务**：它每天读取你在 Codex 中的会话，把值得留存的事实、偏好和做事策略沉淀成可审计的记忆，并在你提问时用当前有效的记忆回答——带引用，不编造。

它不是聊天机器人，也不是云端产品。它是一个常驻本机的后台服务：SQLite 保存运行状态与可重建的检索索引，**Git 仓库是长期记忆的唯一事实源**。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| Agent runtime | `@openai/agents`（OpenAI Agents SDK for TypeScript） | 有界 Agent run：结构化输出、工具调用、guardrails、tracing 开关 |
| Schema 校验 | `zod` | Agent 输出、记忆 frontmatter、API 数据的运行时契约 |
| 语言 / 运行时 | Node.js 24 LTS + TypeScript（strict） | 直接以 `.ts` 运行，无需构建步骤即可测试；`tsc -b` 用于类型检查与产物构建 |
| 包管理 | pnpm workspace | `@aquarius/core` / `@aquarius/server` / `@aquarius/cli` 三个包 |
| HTTP 服务 | Fastify 5 | 只监听 `127.0.0.1`，全部接口要求本地 bearer token |
| 运行状态 | SQLite（`node:sqlite`）+ FTS5 | 任务、游标、审批、安装记录，以及可随时重建的全文检索投影 |
| 事实源 | 原生 Git CLI（窄封装） | 记忆的提交、版本与恢复；写入走 CAS，绝不基于旧状态提交 |
| 后台常驻 | macOS launchd | 只负责拉起与重启；每日 03:00 调度与补跑由应用自己负责 |

## 快速开始

前置：Node.js ≥ 24.10、Git、pnpm。真实模型需要 `OPENAI_API_KEY`。

```bash
pnpm install

# 1) 先跑一次「干跑实例」：不调用模型，用确定性替身验证链路是否通
AQUARIUS_AGENT_RUNTIME=fake AQUARIUS_HOME=~/.aquarius pnpm server

# 2) 另一个终端：自检并查看状态
AQUARIUS_HOME=~/.aquarius pnpm cli doctor
AQUARIUS_HOME=~/.aquarius pnpm cli ingest status
AQUARIUS_HOME=~/.aquarius pnpm cli ingest run            # 立即消化一批会话
AQUARIUS_HOME=~/.aquarius pnpm cli ask "这个项目用什么包管理器"
```

首次启动会生成 `~/.aquarius/config.json`（含本地 API token，权限 0600）、初始化独立的记忆仓库 `~/.aquarius/memory-repo`，并自动创建错过窗口的补跑任务。

接入真实模型：

```bash
export OPENAI_API_KEY=sk-...        # 只放在服务进程环境里
export AQUARIUS_MODEL=gpt-5         # 固定一个模型快照
pnpm server
```

安装为常驻服务（macOS）：

```bash
./scripts/install-launchd.sh
```

## 目录结构

```text
packages/
  core/     # 领域层：记忆契约、Git 存储、适配器、Agent、门禁、检索、任务
  server/   # Fastify API、调度器、launchd 入口
  cli/      # 命令行客户端（只通过本地 API 工作）
deploy/launchd/   # launchd 模板
scripts/          # 安装脚本
docs/             # 设计、架构与流程文档
.scratch/         # 已批准的实现方案与 tracer-bullet tickets
```

## 记忆里有什么

记忆分四类：**经历（experience）**、**用户画像（profile）**、**策略（strategy）** 和 **Skill**。写入规则是确定性的，模型只能提议：

- 经历：一次有效的用户陈述或可验证的工具结果即可写入当前视图。
- 画像 / 策略：用户明确说出的直接生效；模型推断出来的必须有两个独立 case、高置信度且无未解决冲突。
- Skill：同一策略在三个独立成功 case（且至少两种任务特征）之后才生成候选；**发布必须由你批准**。
- 冲突、低置信、敏感内容一律进入 review 队列，不会自动污染当前记忆。

## 常用命令

```text
aquarius doctor                     自检：服务、认证、数据库、Git 仓库、模型配置
aquarius ask "<问题>"               用当前有效记忆回答并给出 memory ID
aquarius memory list|show           查看记忆
aquarius memory correct "<自然语言>" 预览 → 确认 → 提交修正
aquarius ingest run|status          手动消化 / 查看调度与任务状态
aquarius review list|show|resolve   审查冲突与候选（先看 diff 再决定）
aquarius skill list|show|approve|reject|rollback|retire
aquarius index rebuild              从 Git HEAD 重建检索索引
```

所有确认型写入都要求 `expectedHead`：如果预览之后记忆发生了变化，写入会被拒绝并要求你重新生成预览。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 协作与代码开发规范 |
| [DESIGN.md](DESIGN.md) | 设计原则、不变量与关键取舍 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新记录 |
| [TODO.md](TODO.md) | 开发计划与当前进度 |
| [docs/PROJECT-SPEC.md](docs/PROJECT-SPEC.md) | 项目定位、产品目标与功能范围 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、目录结构与数据组织 |
| [docs/COMPONENT-GUIDELINES.md](docs/COMPONENT-GUIDELINES.md) | 模块/组件开发、样式、依赖与可访问性规范 |
| [docs/PAGE-STRUCTURE.md](docs/PAGE-STRUCTURE.md) | 对外界面结构：CLI 命令、HTTP 路由、记忆树布局 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发与发布流程 |
| [docs/REGISTRY.md](docs/REGISTRY.md) | 记忆与 Skill 的构建、校验与分发 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 构建与本机（launchd）部署 |

## 当前状态

首个垂直切片已全部实现并通过测试（85 个自动化测试，含基于真实 Codex 会话的端到端验证）。已知边界与首版不做的事见 [docs/PROJECT-SPEC.md](docs/PROJECT-SPEC.md)「首版不做」。

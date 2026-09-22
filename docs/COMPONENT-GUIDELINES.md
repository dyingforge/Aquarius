# COMPONENT-GUIDELINES — 模块/组件开发、样式、依赖与可访问性规范

原文档树此处注释为「组件开发、样式、依赖和无障碍规范」。Aquarius 首版没有 Web UI，因此本文件把这套规范映射到**代码模块（component = 领域模块）**与**命令行界面**上：一个模块怎么切、怎么依赖、对外怎么表现、错误怎么呈现。若将来加入只读 Web UI，前端规范补在本文件第 6 节。

## 1. 模块的边界

一个模块 = 一个目录 = 一个明确职责。判断标准是：能否用一句话说清它「不做什么」。

- 每个模块通过 `index.ts`（仅包级）或直接文件路径暴露能力；**不暴露内部工具函数**给别人复用，需要的就提取到 `util/`。
- 模块之间只通过**数据**耦合，不通过共享可变状态。跨模块传递的东西必须是可序列化的普通对象或明确的领域类型。
- 一个模块的公开函数应当能用「输入 → 输出」描述；需要外部状态时，通过构造函数注入依赖（看 `IngestService`、`RetrievalService` 的构造参数）。

**依赖注入而非全局单例**：`AquariusService` 是唯一的组合根。测试依赖这个设计——`createEnvironment()` 能把整个系统装进临时目录。

## 2. 依赖规范

仓库依赖刻意保持精简：

```text
@aquarius/core    → @openai/agents, zod, yaml
@aquarius/server  → @aquarius/core, fastify
@aquarius/cli     → @aquarius/core, commander
```

规则：

1. **不新增运行时依赖**，除非标准库做不到。已用标准库替代的例子：ULID（`util/ids.ts`）、异步互斥锁（`util/mutex.ts`）、SQLite（`node:sqlite` + FTS5）、测试框架（`node --test`）。
2. 新增依赖必须在 PR 说明里写清：为什么标准库不行、包体积、维护活跃度、是否引入原生编译或网络副作用。
3. 禁止引入会**自动产生副作用**的依赖（自动上报、自动扫描文件系统、后台定时器）。
4. 版本固定到具体版本（`dependencies` 用精确版本或 `^` 到已知稳定线）；升级依赖要跑全量测试。
5. **不引入第二套 Agent/memory 框架**。SDK 的 beta Memory 只借鉴处理模式，canonical memory 必须由本项目代码写入。

## 3. 代码风格

- TypeScript strict，`noUncheckedIndexedAccess`、`noUnusedLocals`、`verbatimModuleSyntax` 全开；类型不干净就不过。
- ESM + 显式 `.ts` 扩展名导入（配合 `rewriteRelativeImportExtensions` 产出 `dist/*.js`）。
- 优先 `const`、纯函数、`readonly`；类只用于**持有依赖**或**持有跨调用状态**（如 `MemoryStore` 的路径与作者信息）。
- 私有成员用 `#name`，不用 `private`。
- 错误一律 `throw new AquariusError(code, message, { actionable, details })`；不要抛裸 `Error` 到跨模块边界。
- 命名：领域名词优先于技术名词（`Observation`、`ConsolidationOperation`、`GateDecision`），避免 `Manager`/`Helper`/`Util` 这类空词。
- 注释只写**约束**：外部格式的坑、为什么不能用更直观的做法、不变量从哪来。例：

```ts
// `-r` 是必需的：没有它 diff-tree 只报告顶层条目，
// 目录下第一层之后的每个变更都不可见。
await runGit(['diff-tree', '-r', '-p', ...]);
```

不要写「这里把 a 赋给 b」这类复述。

## 4. 契约与校验

- 每个跨边界的数据结构都用 zod 定义在**一处**：记忆 frontmatter（`memory/schema.ts`）、Agent I/O（`agents/contracts.ts`）、适配器输出（`sources/adapter.ts`）。
- 校验发生在**入口**：Agent 输出进流水线之前、记忆文件进仓库之前、API body 进服务之前。内部函数之间不重复校验。
- 契约变更 = 破坏性变更：必须升 `schema_version`、写迁移说明、更新 `ARCHITECTURE.md` 与 `REGISTRY.md`。

## 5. 「样式」：输出与错误呈现规范

CLI 与日志是 Aquarius 的界面，一致性要求与前端样式表等价。

### 5.1 CLI 输出

- 默认人类可读；`--json` 输出原始 JSON（脚本用）。同一个命令的两种输出必须表达同一份数据。
- 列表用对齐表格（`output.ts` 的 `table()`），空集合打印 `(none)` 而不是空白。
- 时间统一相对显示（`5s ago`、`2h ago`），精确时间放 JSON。
- 涉及写入的命令：**先打印将要发生什么（diff），再问，再执行**。非交互环境（无 TTY）下没有 `--yes` 就直接拒绝执行，而不是静默继续。
- 退出码：`0` 成功；`1` 运行期失败；`2` 配置/用法错误；`3` 服务不可达；`4` 认证失败。

### 5.2 错误消息

三段式，缺一不可：

```text
aquarius: <发生了什么，具体到对象>
  → <你现在应该做什么>
```

例：

```text
aquarius: Memory changed since the preview was generated.
  → Preview the correction again against the new HEAD.
```

- 不要在错误里暴露凭据、完整请求正文或会话原文。
- 不要只说「失败了」。要么给出下一步，要么说明是内部错误并指向日志。

### 5.3 日志

- 结构化 JSON 行；字段名稳定（`scope`、`message`、`latencyMs`、`outcome`、`errorCategory`）。
- 全部经过脱敏器；**永不**记录 token、密钥、完整请求正文、reasoning 内容。
- 级别语义：`debug` 开发细节、`info` 状态变化（任务开始/结束、提交）、`warn` 可自愈但需要知道、`error` 需要人介入。

## 6. 可访问性（a11y）

本项目的「用户界面」是终端，因此可访问性要求落在**终端可访问性**上：

1. **不依赖颜色传达信息**。状态用符号与文字（`✓ ! ✗`），颜色只是增强。
2. **不使用需要特定字体或图形环境才能理解的字符**；表格在等宽字体下对齐。
3. **支持非交互环境**：管道、CI、`--json` 下不输出 ANSI 控制字符，不做分页，不等待输入。
4. **可脚本化**：每个命令都有稳定的退出码与 JSON 输出，屏幕阅读器用户可以用 `--json` 配合自己的工具链。
5. 错误消息写完整的句子，避免只有符号的提示（屏幕阅读器读不出 `✗ 403`）。

若将来加入 Web UI，则补上：键盘可达（所有交互有焦点顺序）、语义化标签、对比度 ≥ 4.5:1、尊重 `prefers-reduced-motion`、表单错误与 `aria-describedby` 关联。

## 7. 模块检查清单

新增或改动一个模块时逐条确认：

- [ ] 能用一句话说清职责**与不做什么**。
- [ ] 依赖通过构造函数注入，没有隐藏的全局状态或单例。
- [ ] 跨边界数据有 zod 契约，校验在入口一次完成。
- [ ] 失败路径抛 `AquariusError` 且带 `actionable`。
- [ ] 没有新增依赖，或已在 PR 里论证。
- [ ] 有对应测试，且测试断言外部行为而非内部实现。
- [ ] 没有把会话原文/凭据/本机绝对路径写进日志、测试或 Git。
- [ ] 涉及不变量时已同步更新 `DESIGN.md`。

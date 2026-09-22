# 03: 每日自动增量摄取并补跑

**What to build:** Aquarius 可以在每天固定时间自动发现新的或追加更新的 Codex sessions，增量完成沉淀；机器在调度时间关闭时，下一次启动会补跑且不会重复处理已经消化的事件。

**Blocked by:** 02: 将单个 Codex 会话沉淀为经历

**Status:** ready-for-agent

- [ ] 扫描同时覆盖 Codex 活动 session、归档 session 和 session index，并把 Codex 文件格式隔离在 adapter 内。
- [ ] 调度按 Asia/Shanghai 每天 03:00 创建任务；错过后在下次启动时创建一次 catch-up job，同一自然日不会重复自动执行。
- [ ] 对仍在写入的 session 延后处理；文件后续追加时只消费新增事件。
- [ ] session 从活动目录移动到归档目录后仍被识别为同一来源，不会重复产生记忆。
- [ ] checkpoint 使用稳定 session/event 标识、内容哈希和 adapter schema version，重复扫描保持幂等。
- [ ] 任务有有界重试和明确失败状态；一个损坏 session 不阻止其他 session 完成。
- [ ] Git 已提交但 SQLite 状态更新失败时，服务重启后可以根据 commit metadata 自动对账。


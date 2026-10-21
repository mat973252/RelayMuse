# P1 任务终态与执行并发修复结果

日期：2026-10-20，Asia/Shanghai。基线：`eb8a4178086e9c1d1c4abee353b41c4fdfdd309a`，分支 `codex/pi-persisted-result-gate-20260930`。本次为本地工作区修改，尚未提交、推送或发布。

## 结果与行为

本机验收通过。修复原先 `complete()` 的等待/效果检查与执行准入分离、以及 adapter 等待期间取消后继续执行的问题。

- `runTaskEffect()` 与 `complete()` 共用持久执行租约。完成检查期间不能准入新效果；效果已经准入、尚未写 PREPARED 的窗口也不能完成任务。同一任务的并发效果或完成调用抛出 `TaskExecutionBusyError`，不自动重试。
- 执行准入在同一短事务中核对任务状态并占有租约。即使入口持有旧 ACTIVE 快照，已完成/取消任务也无法准入效果。
- 取消无需等待执行租约。取消先提交会拒绝后续准入；先前已准入的操作可能继续执行，保留 CONFIRMED/FAILED/UNKNOWN。取消不代表外部请求已撤回。
- adapter 返回后核对终态；continuation 通过带状态条件的 TASK_RESUMED 提交准入。取消先赢得该提交时，不运行 continuation，也不写虚假的 TASK_RESUMED。
- `parkAwait` 未提交时不再返回虚构等待点；取消赢得 adapter 等待点提交时，resume 返回 cancelled。
- 完成的最终提交再次检查 pending await，防止等待点在初始快照之后入库却被完成检查跳过。
- execution lease 与原有 resume run lease 独立，continuation 内可以调用效果与完成。真实 SIGKILL 后按死 PID 和精确 owner id 回收 execution lease；不会清除 journal 或授权 SUBMITTED/UNKNOWN 重放。

## API 与取舍

TaskStore 新增 `claimExecutionLease`、`releaseExecutionLease`；自定义存储实现需要实现相同原子性。SQLite 新增 `relay_task_execution_leases` 表，不改写已有任务/效果历史。事务仅覆盖本地状态读写，不跨 execute、adapter 或 reconcile 的网络 await。

选择每任务单个执行租约，串行效果与完成检查，避免另建效果计数器或嵌套 resume 锁。取消仍可即时提交。业务 callback 若已经准入，可以在取消时仍然运行；其后通过 TaskRuntime 发起的新效果会被拒绝。任意绕过 TaskRuntime 的外部调用不受保护。

部署时先停止旧版本 runtime writer；旧二进制不会参与新协议。此机制仅支持同机共享工作区。PID 复用可能保守地报告 busy，不能据此声称实现分布式 fencing。

## 实际验证

Windows，Node v24.13.0，pnpm 10.33.0。先新增 7 个确定性交错测试：旧代码 75 通过、7 失败；修复后这些测试全部通过。随后补充取消与 park 提交、最终 continuation 准入、UNKNOWN 保留和 pending await 竞争。

最终 `npx --yes pnpm@10.33.0 check` exit 0，包含 typecheck、单元和集成测试。执行时间 12:38:38–12:40:16：

| 包 | 测试 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| core | 86 | 86 | 0 | 0 |
| storage-sqlite | 57 | 57 | 0 | 0 |
| cli | 70 | 68 | 0 | 2 |
| adapter-pi | 22 | 22 | 0 | 0 |
| mcp | 55 | 55 | 0 | 0 |
| artifact-fs | 12 | 12 | 0 | 0 |
| epistemic | 8 | 8 | 0 | 0 |
| 合计 | 310 | 308 | 0 | 2 |

相比基线新增 19 项：core 11 项、SQLite 8 项，其中 6 项使用独立真实子进程、IPC 屏障和同一 SQLite 文件，覆盖完成/准入竞争、并发执行、取消、等待点竞争、SIGKILL 及只读对账恢复。没有依靠 sleep 猜测关键交错；没有真实模型或真实发布服务请求。既有两个跳过分别是 Windows chmod 写入限制与 symlink 创建权限。

独立只读复核发现 adapter park 未提交仍返回 await 的边界，已修复并增加测试。`git diff --check` 通过。

Workbench 记录：`0ae6af69598b472cbc047b84b56c1b38`，result=passed、exit_code=0、source_unchanged=true。记录读回 `current_pass=true`、日志 integrity=matched、113 个所选源码文件快照匹配。覆盖范围为 packages、package.json、pnpm-lock.yaml、tsconfig.json。

原始最终日志：`validation/workbench/0ae6af69598b472cbc047b84b56c1b38.log`，SHA-256：`ea2900e8d4e8285fe810179ff7e9cdc64fdb708fa84f98f94d24acc545af21a4`。工作台 HTTP 验收接口仍超时，本次未确认页面展示。

## 修改与后续边界

实现与测试位于 core 的 task/index、SQLite task-store、对应测试及 IPC child fixture；接口语义见 `docs/TASK_EXECUTION_CONCURRENCY.md` 和 core README。

本次只处理终态与并发 P1。deferred 空文本被当 completed 的另一项 P1，以及 CLI WAITING 的退出码 P2，仍待后续修复。未验证 Linux/Node22、新 hosted CI、跨机恢复或真实发布服务；旧 Linux Node24 deferred 偶发失败仍不能当作已修复。当前通过不等于生产安全。

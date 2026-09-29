# RelayMuse v0.2 独立审查

日期：2026-09-29。对象：relay-v0.2-muse-runtime.tar.gz 解压快照。
结论：**PARTIAL**。架构方向合理，现有回归通过，但恢复、审批和完成状态存在可复现缺陷，不能直接沿用原报告的完整 PASS。

## 1. [P1] Pi 未恢复成功仍执行应用 continuation

位置：`packages/core/src/task.ts:723-733`；`packages/adapter-pi/src/task-adapter.ts:125-140`。

PiTaskAdapter 超过轮询次数后返回 `resumed:false`。TaskRuntime 不检查此值，仍调用 continuation，并返回 `outcome:resumed`。示例 continuation 会 publish 并 complete。因此远程 deferred job 尚未完成也可能进入发布阶段。

复现 R1：adapter 返回 `{resumed:false,detail:'still pending'}`；continuation 被调用一次，任务成为 COMPLETED，CLI 所依据的 outcome 仍为 resumed。

建议：区分 pending、failed、idle、completed 等恢复结果；只有符合应用继续条件时进入 continuation，并将 pending 持久化为可恢复等待。不能简单将所有 resumed=false 都视为失败，因为无 deferred 的 idle 情况也需要定义。

## 2. [P1] 审批只绑定名称，批准后的请求可以变化

位置：`packages/core/src/task.ts:506-514,540-545,576-580`。

APPROVAL await 仅记录 effect name，不存 kind/request hash；审批前没有 PREPARED journal row。用户批准 publish A 后，重启应用加载同名 publish B，请求 B 可直接执行，旧审批仍有效。已有 journal 的 requestHash 校验保护不了这个窗口，因为审批前 journal 尚不存在。

复现 R2：A 请求创建 await → approve → resume 使用同名 B 请求；实际 published=[B]，pending=[]。

建议：在审批时固定并显示操作 kind、请求摘要及 hash；执行前验证与已批准内容一致，发生变化重新审批。

## 3. [P1] UNKNOWN 副作用可被标记为完成，后续 resume 不再核对

位置：`packages/core/src/task.ts:881-890,650-653`；示例 `examples/pi-muse/pi-muse-runtime.mjs:133-155`。

complete 只检查 pending awaits，不检查未结算 effects。runTaskEffect 在 execute 抛 AmbiguousEffectError 后返回 unknown，但不会自动创建等待。应用仍能 complete；后续 resume 对 COMPLETED 提前返回，永久绕过 reconciliation。示例 continuation 也不检查 effect outcome 是否 confirmed，就写“approved and published”并完成，普通 publish 失败同样会得到虚假完成记录。

复现 R3：execute 抛 AmbiguousEffectError → complete 成功 → snapshot 同时为 COMPLETED 且 unresolvedEffects=[UNKNOWN] → resume 返回 already completed。

建议：完成前检查全部任务 effects；未结算时拒绝完成并保持恢复入口。示例仅在明确 confirmed 后生成成功 receipt/decision，failed 和 unknown 分别阻断。

## 4. [P2] 创建 await 与将任务停为 WAITING 有两个提交窗口

位置：`packages/core/src/task.ts:465-466`；SQLite 的两个单独事务分别在 `packages/storage-sqlite/src/task-store.ts:279-297,235-253`。

insertAwait 已提交后、transitionTask 前进程死亡，留下 ACTIVE + PENDING APPROVAL。runTaskEffect 的准入只检查 ACTIVE，未检查所有 pending waits；此窗口下的状态不能可靠表示任务已停。resume 可以修复状态，但调用方必须先走 resume 才会自愈。

复现 R4：在两个提交之间注入异常，读取持久化结果为 ACTIVE、pending=1。此复现使用故障注入模拟进程死亡边界，不是实际 SIGKILL。

建议：将 await、WAIT_CREATED 与任务状态变化放入同一事务，并在执行入口检查有效等待门禁。

## 5. [P2] 默认 demo 无法稳定复现报告的 33/33

位置：`examples/pi-muse/demo.mjs:44-46,59,143,162`。

默认 Node 24.13.0 会产生 SQLite ExperimentalWarning。demo 将 stderr 拼进 stdout，再 JSON.parse 全部文本，首次 task show 即 SyntaxError。禁用警告后 Windows 下 child close 的 signal 不等于 SIGKILL，断言失败；实际远程提交/恢复路径仍成功。PATH 前缀还硬编码了 Unix `:`，应使用 node:path 的 delimiter；本机已有可用 pi 时该错误可能被掩盖。

建议：分别捕获 stdout/stderr，只解析 stdout；跨平台确认强制终止，并继续检查未提交本地确认和远端请求计数；PATH 使用 delimiter。

## 实际验收

环境：Windows / Node v24.13.0 / pnpm 11.19.0。压缩包声明 pnpm 10.33.0，本次未跑该版本或 Node 22 的矩阵。

- `pnpm install --frozen-lockfile`：依赖解包完成，但 pnpm 11 首次退出 1，提示被忽略的依赖构建脚本。
- `pnpm typecheck`：退出 0。
- 将 `packages/adapter-pi/node_modules/.bin` 加到 PATH 后 `pnpm test`：退出 0；226/226，失败/跳过均为 0。日志 `test.log`。
- `node examples/pi-muse/demo.mjs`：JSON 解析异常，未完成验收。日志 `demo.log`。
- 设置 `NODE_NO_WARNINGS=1` 后运行 demo：退出 1；32/33，远端 submissions=2、publishRequests=2、mutations=2。日志 `demo-no-warnings.log`。
- `node ../reproduce.mjs`（从解压项目根目录运行）：四项缺陷现象全部复现，退出 0。脚本和日志在本审查目录。

源码未修复。构建产生 dist/node_modules；pnpm 自动改写的 pnpm-workspace.yaml 已按压缩包原字节恢复。

## 项目能力与证据边界

值得保留：core 不依赖 Pi，SQLite 任务/事件存储复用现有数据库，副作用复用原 journal，UNKNOWN 不自动重发。无需推倒重写。

目前是可运行的任务连续性基础和受控参考应用，尚不是可直接处理真实发布的个人 Agent：

- Pi AgentSession API 确实被调用，但 model/provider 是 mock，本地 HTTP fixture 并不证明真实模型或真实发布服务可用。
- `examples/pi-muse/pi-muse-runtime.mjs:79-86` 固定生成 result=pass，没有执行 package 测试；releasable belief 并非真实检查证据。
- receipt 没有设置父 artifact，demo “artifact lineage present”的断言只检查 snapshot 中至少两个 artifact 引用，未验证父子 lineage。
- task resume 缺少任务级并发锁；原报告已披露。journal 去重不能替代对 agent continuation 和任务状态的独占控制。
- TIME/EXTERNAL 尚未实现，且当前 USER await 只能经核心 API resolve，CLI 没有相应入口。

优先修复 1–3，再补充负路径验收：慢 deferred、审批后请求变化、publish unknown/failed。通过这些后，再推进真实 Pi provider 切片和任务并发恢复验证。

# P2 CLI 任务退出码修复与评审问题收口

日期：2026-10-20，Asia/Shanghai；最后核验 22:20。基线 HEAD `eb8a4178086e9c1d1c4abee353b41c4fdfdd309a`。在前两轮未提交修复上继续，全部修改仍未提交、推送或发布。

## 按优先级的状态

| 顺序 | 优先级 | 问题 | 状态 |
| --- | --- | --- | --- |
| 1 | P1 | 任务终态与执行并发：终态准入、执行互斥、取消后的结果保留、完成与等待竞争 | 前轮已修，本轮完整回归通过 |
| 2 | P1 | deferred 空文本被误判 completed，错误放行 continuation | 前轮已修，本轮完整回归通过 |
| 3 | P2 | CLI 将等待中的任务按成功退出；恢复后再次等待/阻塞也返回 0 | 本轮已修 |

原评审三项已确认问题均已完成对应修复。历史 Linux Node24 deferred 偶发失败仍未定位，属于下一项跨平台验证工作；本轮 Windows 绿色结果不能证明它已解决。

## 本轮行为与范围

`task run` 和实际执行 continuation 的 `task resume` 均按最终持久任务状态返回：ACTIVE/COMPLETED = 0、WAITING = 1、BLOCKED/CANCELLED = 2。恢复成功进入 continuation 后若再次等待或阻塞，也返回对应非零码。ACTIVE 仍允许返回 0，不能将 exit 0 当成任务已完成。

沿用未知任务 66、参数错误 64，以及只读查询成功返回 0 的行为。没有改变审批、重放、Pi agent loop 或 session 语义。

最小生产修改：CLI 内统一状态到退出码的映射，resume 在 continuation 完成后重新读取持久状态。同步 CLI README 与两个示例的 WAITING 预期。源码范围为 `packages/cli/src/task.ts`、对应测试、`packages/cli/README.md`、`examples/pi-muse/demo.mjs`、`examples/pi-muse/real-provider-demo.mjs`。

## 测试先行与实际结果

新增 run/resume × 五种最终状态，共 10 个真实 CLI 子进程回归；同时读回任务状态与 pending await 数量。旧实现 4 个失败：run WAITING、run CANCELLED、resume WAITING、resume BLOCKED 错误返回 0；其余 6 项通过。修复后 10 项全通过，既有审批漂移回归也通过：旧审批不授权新请求，重新审批后只执行一次。

| 验证 | 环境 | 实际结果 |
| --- | --- | --- |
| 新增状态矩阵与审批漂移定向测试 | Windows Node24.13.0 | 11/11 通过 |
| CLI 全包测试 | Windows Node22.23.3 | 80 项，78 通过、0 失败、2 跳过，exit 0 |
| `npx --yes pnpm@10.33.0 check` | Windows Node24.13.0 | 326 项，324 通过、0 失败、2 跳过，exit 0；含 typecheck |
| `node examples/pi-muse/demo.mjs` | 默认 mock/localhost fixture | 41/41 检查通过，exit 0 |
| `git diff --check` | 当前工作区 | 通过 |

完整 check 分包：epistemic 8、core 86、artifact-fs 12、storage-sqlite 57、mcp 55、cli 80、adapter-pi 28。两个既有跳过来自 Windows chmod 无法可靠拒绝写入及 symlink 权限条件。Node22 CLI 测试使用本轮已编译产物；没有在 Node22 运行全项目 check。

全部为离线 provider/localhost 受控测试。真实 provider 示例的退出码断言由离线 HTTP fixture 覆盖；本轮未直接调用真实模型或真实发布服务，没有启动 Devin 或恢复 Claude 监测。

## 验收证据

完整 check 时间：北京时间 22:16:31–22:18:09。Workbench 记录 `cf94533504334a4c875e8c6c47e06a5c`：passed、exit 0、记录命令报告 source_unchanged=true；独立读回 current_pass=true、所选源码和日志哈希 matched。

日志：`validation/workbench/cf94533504334a4c875e8c6c47e06a5c.log`。SHA-256：`a05a09553db54ae27d5c9789603aab8c3c8fc8ee6a86e9ffcdfd95b15625c8bf`。

本聊天 work 保留定向 red/green、Node22 CLI 和默认示例日志。Workbench HTTP 验收接口本轮 3 秒超时，尚未确认页面展示。

后续按风险优先做历史 Linux Node24 deferred 偶发的隔离复现与定位；本轮不据此虚构新的已确认缺陷，也不将受控验证等同于生产稳定性或真实模型端到端验收。

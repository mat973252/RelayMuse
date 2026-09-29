# RelayMuse 阶段 1 / 2 独立验收

验收者：Codex。2026-09-29，Asia/Shanghai。

## 接受的提交

- 阶段 1：PR #1，head `03be62c6fea259a7b9b2e5a6852532789f0e7272`；merge `f390f62af0e8de0ad1097095efeecd5eab06a9c0`。
- 阶段 2：PR #2，head `64a6b295db10c1f872b841b8f6a8a64c1f771c6e`；merge `39919bfc803f7aef57721f6902c2805f0e2f806e`。

每次交付均在隔离 checkout 精确检出，独立读 diff、运行验收后才合并。CI 和 Devin 自验只是补充证据。

## 实际运行

Windows Node `24.13.0`，项目声明的 pnpm `10.33.0`。

| 验收 | 命令 / 方式 | 结果 |
|---|---|---|
| 阶段 1 回归 | `npx --yes pnpm@10.33.0 check`，工程 head `0dce8de` | exit 0；261 tests，259 pass，2 skip，0 fail |
| 阶段 1 退出兼容复测 | Pi FAILED publish 用例单独重跑 | exit 0；accepted head 后续仅准确注释/报告变化 |
| 阶段 2 完整回归 | `npx --yes pnpm@10.33.0 check`，head `64a6b29` | exit 0；277 tests，275 pass，2 skip，0 fail |
| 阶段 2 默认 demo | `node examples/pi-muse/demo.mjs` | exit 0；41/41；submissions=2，publishRequests=2，mutations=2 |
| 独立锁竞态复现 | 两个 SQLite 连接，B 在读状态后、claim 前暂停；A 完成释放后 B 继续 | 旧 head continuation=2；接受 head continuation=1，B 返回 completed/already |

两项 skip 均为本机符号链接创建权限限制；安全门禁、并发与崩溃验收没有跳过。Node22/24 Linux/Windows CI 四项通过，默认 demo 已纳入 CI。

## 行为验收

- 慢 deferred / failed adapter 不继续，连续轮询复用等待；人类和应用 EXTERNAL 等待仍阻挡 adapter。
- 审批 A 不放行同名请求 B；SQLite 关闭重开后绑定仍有效；旧无绑定审批 fail closed。
- UNKNOWN / FAILED 不假完成、不生成成功 receipt；UNKNOWN 恢复只读 reconcile，不盲 POST。
- await / WAITING / 事件原子落库；真实 HTTP commit 后强杀恢复 POST=1。
- 默认 demo 分离 stdout/stderr、平台 PATH delimiter；kill-intent 与无 after-kill、远端 commit、未结算 journal 共同验证预期崩溃；普通非零退出负例不满足证据。
- 合成 package 真子进程测试；artifact 保存真实命令、退出码和输出摘要；失败 readiness 的 artifact 内容、rejected belief、无发布均有断言。
- manifest → 测试证据 → receipt 父子 lineage 解析与内容/完整性核验通过。
- 并发 resume busy、owner 强杀后回收、锁后 fresh COMPLETED/CANCELLED 检查及真实 child 延迟 claim 回归通过。

## 边界

这是受控本机 / 同一 workspace / HTTP fixture / mock Pi provider 验收，不是生产或真实模型接入证明。PID 回收不识别进程代际，PID 复用可能使旧锁暂时 busy；不是分布式锁。Windows 100ms 退出延时是兼容缓解，不证明任意异步 I/O 已刷盘。阶段 3 尚未启动，需另行核对可用模型配置与预算。

未发布 npm，未执行真实发布、邮件或交易，未修改原 Relay。UI SWE-2 High 与 API `swe-2-max` 差异仍保留。

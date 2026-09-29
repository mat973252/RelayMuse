# RelayMuse 分阶段完善计划

2026-09-29：用户授权 Devin Cloud 执行、Codex 把控进度并独立验收，建立开源仓库。仓库源自 Relay，保留 MIT 和 Git 历史。当前 baseline 是用户提供的 v0.2 压缩包；原 PASS 已被独立 review 限定为 PARTIAL。

## 阶段 1：修复恢复、审批和完成门禁

实现者：Devin Cloud；验收者：Codex。

1. Pi adapter 未成功恢复或仍 pending 时，禁止应用 continuation 和副作用；明确定义 idle/no-deferred 与 failed/pending 的差别。
2. 审批持久化绑定 kind + requestHash，执行前核验；请求变化重新审批，旧无内容绑定的审批不得静默放行；批准两次仍幂等。
3. complete 拒绝未结算 effects；failed/unknown 不得生成成功 receipt、成功 decision。resume 保持 reconciliation 路径，无盲重试。
4. 创建 await、事件和 WAITING 变化单事务；保持旧 DB 兼容。effect 入口尊重 pending wait。

验收：先写失败测试，再最小修改；SQLite 关闭/重开验证审批和等待；slow deferred 无发布；批准 A 后 B 不执行；UNKNOWN 无法完成；远端 commit 后崩溃恢复 POST=1；原回归全通过。提交 draft PR，等待独立验收。

## 阶段 2：可信示例与并发恢复

先由 Codex 验收阶段 1，再派发。

- stdout/stderr 分离、跨平台 PATH 与强杀验证，Linux/Windows 默认 demo 不需要禁用 warning。
- release readiness 来自真实合成 package 测试命令的 exit code / 内容摘要，失败时不出现 releasable belief；artifact 父子关系有真实 lineage 验证。
- 增加最小任务级单写者锁与崩溃释放/恢复；并发 resume 必须只有一条 continuation，不只依赖 effect 去重。
- CI 纳入新增负路径和 demo，覆盖 Node 22/24、Linux/Windows；README 展示当前可证实的能力和边界。

## 阶段 3：真实 Pi 接入验收

在阶段 2 独立通过后，核对当时 Pi 公共 API，接入一个现有可用真实模型，只用合成业务和本地受控 effect。没有可用 provider/凭据则明确阻塞，不能把 mock 充当真实 provider；凭据只走已有本机配置，不传入 Devin 提示或仓库。

禁止新增 UI、workflow DAG、Pi fork、平台化框架、自动真实发布、收费或 npm release。每阶段有明确停止点和预算上限，不自动扩 scope。

## 交付与接受规则

Devin 在特性分支提交 PR，提供 commit、修改列表、实际命令/exit code/测试数量和未覆盖边界。Codex 拉取精确 commit，独立阅读 diff 与运行验收；维护者自验和 CI 不替代独立验收。验收失败发具体返工，通过后才接受和派下一阶段。

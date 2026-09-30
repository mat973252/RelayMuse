# Pi 持久结果门禁：2026-09-30 本地迭代

## 结论与范围

本轮子任务 PASS；阶段3仍为 PARTIAL。实现与验收：Codex。基线 `f64d526`，本地分支 `codex/pi-persisted-result-gate-20260930`。

用户于 2026-09-30 授权从工作区自主选择项目推进。选择 RelayMuse，落实既有 `tasks/RELAYMUSE_STAGE3_REAL_PI.md` 中 session 精确绑定与同步结果门禁这一段。此次没有执行真实模型请求，也没有恢复 Devin 计费会话。只读 API 当前仍为 suspended / usage_limit_exceeded，GitHub 无 open PR；昨晚未交付的 Devin 修改不属于此次成果。

## 问题与改动

旧实现把“session 存在且没有 deferred”当作 idle，TaskRuntime 允许 continuation。新增回归先复现 8 个失败测试：同步正常结果没有输出，error/aborted/length/toolUse 误放行，空结果和失效引用误报 idle，旧分支 deferred 被错误恢复。

- attach 使用 Pi 0.87.0 公开 `getSessionId()` / `getSessionFile()`，删除私有属性强转和目录首个 JSONL fallback。
- 严格解析精确 session 文件，再用公开 `SessionManager.inMemory()`、`getBranch()`、`buildSessionProjection()` 获取当前分支结果。仅正常 stop 且文本非空的最终 assistant 允许 completed；读取已保存结果时 resumed=false，不请求模型。
- 校验 session 身份；拒绝缺失、空文件、截断 JSONL、新 prompt 尚无结果、错误、中止、token 截断、未完成 toolUse 和空文本。失败返回 failed，既有 TaskRuntime adapter 门禁阻止 continuation。
- 校验最终消息与 projection 来源相同，避免 context edit 隐藏新 prompt/失败后复用旧成功。旧分支 deferred 不再参与当前任务；保留当前 deferred 的原生 fetchDeferred 路径。
- 门禁通过内存 projection 保持只读；没有使用可能修复空文件或迁移磁盘文件的 SessionManager.open。

## 验证

平台：Windows，Node 24.13.0，pnpm 10.33.0；依赖按 frozen lockfile 安装，Pi coding-agent 0.87.0。同步 provider 是离线合成 fixture，AgentSession 是真实 Pi SDK 创建；它不是线上模型验收。

| 命令 | exit | 结果 |
| --- | --- | --- |
| `npx --yes pnpm@10.33.0 typecheck` | 0 | TypeScript 构建通过 |
| `node --test packages/adapter-pi/dist/test/task-adapter.test.js` | 0 | 11 pass，0 fail，0 skip |
| `npx --yes pnpm@10.33.0 check` | 0 | 287 tests，285 pass，0 fail，2 skip（Windows 符号链接权限） |
| `node examples/pi-muse/demo.mjs` | 0 | 41/41；两个任务合计 submissions=2、publishRequests=2、mutations=2 |

同步合成 attach 两个不同 session，各一次模型调用；resume 后累计 modelCalls=2。独立 Node 子进程读取同一同步结果，session 字节与 mtime 不变。error/aborted/length/toolUse 各自经真实 TaskRuntime 门禁检查 continuation=0。原 deferred 测试 attach/restart/double-resume 仍 submissions=1。demo 覆盖审批、崩溃、恢复、lineage 和本地 HTTP effect，仍为受控 fixture 证据。

原始本机日志：`D:/code/aiproject/_review/relaymuse-20260930/check-final.log`、`demo.log`。它们不是仓库交付文件。

## 需求依据与证据限制

本轮是既有阶段3计划中的失败门禁修复，依据原始任务与上述可复现问题，没有扩功能。复核已有社区依据 [MCP SEP-1597](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1597)（发布 2025-10-02，本次核验 2026-09-30，当前 Closed）：其讨论支持故障、重试和持久操作身份需求，是协议提案而非 RelayMuse 采用或业务损失证据。由此联系到“恢复应核验当前结果”是助手推断；具体缺陷由本地失败测试证实。已有 Temporal 原帖本次抓取失败，不据此新增结论。

## 仍待完成

1. 通过已有 Pi ModelRuntime / 本机配置接入真实同步 provider；凭据仍由 Pi 加载。
2. 显式 opt-in 的短合成真实模型示例，禁止加载工具、extensions、skills 和个人上下文，并验证任务审批/effect 闭环。
3. 本轮新代码的 Node22/24 Linux/Windows CI；本轮只验证 Windows Node24。deferred 完成结果写回与 provider 错误处理仍沿用既有逻辑，本轮未扩展其保证。

没有证明真实发布服务、生产安全或外部采用；阶段3不能因本轮局部 PASS 被标为完成。

## 修改文件

`packages/adapter-pi/src/task-adapter.ts`、`packages/adapter-pi/test/task-adapter.test.ts`、`README.md`、本报告、`reports/RELAYMUSE_COORDINATION.md`。

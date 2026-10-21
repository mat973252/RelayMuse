# examples/pi-muse — Release Assistant (Relay v0.2 vertical slice)

A reference app for the Muse-style durable personal-agent runtime built on
Relay. It demonstrates the whole killer slice across **real process kills**:

```
task run → WAIT (human approval) → process exits → restart → still WAITING
  → approve → resume → Pi deferred job completes → publish executes once
  → COMPLETED
```

plus the ambiguity leg:

```
resume → POST /publish commits remotely → SIGKILL before CONFIRMED
  → restart → resume → reconcile (read-only) → CONFIRMED → COMPLETED
```

Nothing survives a process boundary except `.relay/` durable state:
`storage.db` (tasks + awaits + task events + effect journal, one file), the
artifact store, and the Pi session file referenced by `agentRef`.

## Layout

| file | role |
| --- | --- |
| `demo.mjs` | orchestrator: starts the release server, spawns each `relay task …` command as a **separate child process**, asserts 41 checks, prints PASS/FAIL |
| `real-provider-demo.mjs` / `real-provider-runtime.mjs` | explicit opt-in: one configured real Pi model call, persisted result gate, approval, fixture commit/kill/concurrent recovery; 16 checks |
| `pi-muse-runtime.mjs` | the app-side module loaded by `--adapter-module`: `adapter` (PiTaskAdapter + mock deferred provider), `effects` (approval-gated publish spec with reconcile), `run` (check package → artifact evidence → ASK), `continuation` (publish → receipt artifact → decision → complete) |
| `fixtures/release-server.mjs` | local, fully observable "remote": deferred jobs (`POST /js`, `GET /js/:id`), counted mutations (`POST /publish`), reconcile probe (`GET /effects/:key`), `GET /state` |

## Run it

```sh
pnpm install && pnpm check   # build all packages first
node examples/pi-muse/demo.mjs
```

Expected tail:

```
=== SLICE PASS — 41/41 checks ===
```

## Operator flow (what the demo drives)

```sh
relay task run --agent pi --adapter-module examples/pi-muse/pi-muse-runtime.mjs "release pkg-1"
# → task <id>; agent attached; publish decision: awaiting-approval; status WAITING

relay task list                          # fresh process still sees WAITING
relay task show <id>                     # derived snapshot: waitingFor APPROVAL
relay task resume <id>                   # → blocked reason=await-pending (exit 1)
relay task approve <id>                  # → resolved-awaits 1 (repeat → 0)
relay task resume <id> --adapter-module examples/pi-muse/pi-muse-runtime.mjs
# → gate: capabilities → unsettled effects → awaits → adapter.resume
#   (Pi fetchDeferred polls → job completes) → publish executes ONCE → COMPLETED

relay task events <id>                   # committed lifecycle facts
relay effects --history --key task/<id>/publish   # journal evidence
relay doctor                             # capability gate, exit 0/1/2
```

## Crash leg

`MUSE_CRASH_AFTER_PUBLISH=1` makes the runtime module `SIGKILL` itself inside
`execute()` *after* the remote commit lands. The journal row stays `SUBMITTED`;
the next `relay task resume` reconciles via `GET /effects/:key` and marks
`CONFIRMED` — the remote mutation count stays exactly 1.

## Boundaries honored

- No Pi fork, no agent-loop reimplementation — `PiTaskAdapter` uses only
  `createAgentSession`, `SessionManager`, `ModelRuntime.fetchDeferred`.
- No second DeferredHandle/session primitive; `agentRef` stores references.
- Approval is a real gate: the `APPROVAL` await blocks `runTaskEffect` in the
  runtime, not prompt text.
- The default demo uses a local mock provider with an ambient credential stub.

## 真实模型合成验收（显式 opt-in）

先构建仓库，并在本机 Pi 中配置可用模型。凭据由 Pi 的 `ModelRuntime` 加载，
无需复制到 RelayMuse、命令参数或证据目录。以下命令会调用真实模型，可能产生费用；
`--approve-fixture` 只批准本次合成发布 fixture。

```sh
node examples/pi-muse/real-provider-demo.mjs --opt-in --approve-fixture --provider aisix --model deepseek-v4-flash --evidence ../_review/real-pi-proof
```

使用自己的已配置 provider/model；无可用配置或调用失败时验收失败，不回退到 mock。
每次运行需使用新的证据目录；已有 `.relay` 时脚本拒绝覆盖。

模型只接触固定短合成文本。工具、扩展、skills、上下文文件与自动重试关闭；
Pi prompt 60 秒后 abort，CLI 子进程 80 秒后强杀。请求设置 `maxTokens=64`，
但上游如何执行该限制未证明，不能将它视为硬性费用上限。
Pi 公共请求边界只允许一次调用；这不证明网关或上游内部没有重试。

正常非空输出匹配后才运行合成 package 测试、保存证据并等待审批。
示例随后批准 fixture、在远端提交后强杀，再由两个新进程竞争恢复。
预期输出 `PASS` / 16 checks / `piModelRequests=1` /
`publishRequests=1` / `mutations=1`。同步结果恢复只读原 session，
不重新加载模型或凭据，也不再次调用模型。

证据目录保留 `result.json`、等待/崩溃/完成快照、Pi session、模型计数与 artifact lineage。
凭据、请求 headers 与 stderr 原文不写入结果日志；该约束及 canary 检查不代表任意
opaque bytes 都无秘密。不要公开未经检查的个人证据目录。
本次真实模型及各平台结果见[阶段3验收](../../reports/RELAYMUSE_STAGE3_RESULT_2026-09-30.md)。
发布服务始终是 loopback 合成 fixture，真实发布服务与生产安全不在验收结论内。

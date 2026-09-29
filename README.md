# RelayMuse

实验中的持久任务运行层，基于 [Relay](https://github.com/mat973252/Relay)，首个参考应用集成 Pi。保留原项目 MIT 许可证与署名。

当前状态：**PARTIAL / 正在修复**。2026-09-29 独立检查确认现有 226 项回归通过，但发现审批请求绑定、Pi 等待恢复、UNKNOWN 完成门禁及等待事务问题。详见 [独立审查](reports/INDEPENDENT_MUSE_REVIEW_2026-09-29.md)。修复和独立验收前不建议用于真实发布或其他不可逆操作。

`examples/pi-muse` 使用本地 mock provider；尚无真实模型/真实发布服务验收。现有 npm 名称和下方 v0.1 安装说明属于上游 Relay，不是 RelayMuse 已发布版本。`reports/` 中旧 PASS 和发布记录只代表对应日期、对应场景的历史，不代表本仓库已通过 v0.2 验收。

开发：Node 22.13+/24，pnpm 10.33.0；`pnpm install --frozen-lockfile`，`pnpm check`。

## Relay 上游说明（历史基线）

**Durable execution continuity for AI agents.**

Relay is an independent execution-continuity project whose first reference integration is built on **Pi AgentHarness**.

Relay does **not** reimplement Pi's agent loop, session tree, suspended runs, deferred model calls, resume semantics, or tool replay policy. Instead, Relay extends Pi across the boundaries Pi should not have to own by itself:

1. **External Effect Safety** — know whether irreversible outside-world actions actually happened.
2. **Artifact Lineage** — keep important outputs outside chat context with traceable provenance.
3. **Capability Contract** — verify a restored environment can really continue the work.
4. **Portable Capsule** — export/import the durable execution context across controlled machine migration.

## Core principle

> Pi owns agent execution semantics. Relay owns continuity with the outside world.

## v0.1 scope

Relay v0.1 covers these milestones:

- **M0 — Native integration:** load as a Pi package/extension without forking Pi.
- **M1 — Crash-safe effects:** unsafe external effects are never silently duplicated.
- **M2 — Durable artifacts:** outputs survive outside conversation context with lineage.
- **M3 — Portable execution:** export on machine A, import on machine B, validate capabilities, and resume with Pi.
- **M4 — Deferred migration:** a Pi suspended/deferred operation is resumed without submitting the remote job twice.
- **M5 — Chaos gate:** crash-injection matrix passes at critical boundaries.

## Language

- TypeScript 5.9+
- Node.js 22/24
- SQLite for Relay effect journal
- Filesystem + SHA-256 content-addressed artifacts
- YAML capability contract
- tar.gz capsule format for v0.1

No Java/Go/Rust in v0.1.

## Local workspace

The first release is **v0.1.0**, under the [MIT license](LICENSE).
For npm installation and MCP configuration, see the [usage guide](docs/NPM-USAGE.md):

```sh
npm install -g @mat973252/relay-cli@0.1.0 @mat973252/relay-mcp@0.1.0
relay --help
```

Use Node 24 or Node 22.13+. To build the source, use pnpm 10.33.0:

```bash
git clone --branch v0.1.0 https://github.com/mat973252/Relay.git
cd Relay
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
node examples/crash-demo.mjs
```

The demo needs no model account. See [release scope and verification](reports/RELEASE_V0.1.0.md).

Everything runs from the repository root; no machine-specific paths are embedded:

```powershell
corepack pnpm install
corepack pnpm check   # typecheck + tests
node packages/cli/dist/src/cli.js doctor
```

The M0 bootstrap script derives the repository root from its own location:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-relay-m0.ps1
```

See `AGENTS.md` and `tasks/` before implementation.

## The one-sitting proof (no Pi, no model account, no Docker)

```bash
corepack pnpm install && corepack pnpm typecheck   # build once
node examples/crash-demo.mjs
```

Expected tail of the output: a child process is force-killed **after** the local
HTTP counter has committed but before any local confirmation; on restart the
same operation id replays, Relay asks a read-only reconciliation question,
and the assertions print `PASS` seven times with both the remote counter and
submit-request count at exactly 1. Real guarantee: **no silent retry of an ambiguous unsafe action** —
stronger guarantees need downstream idempotency or a reliable reconciliation
query.

## 订单报表业务沙箱

业务服务在独立进程中把合成订单的导出任务写入 SQLite，由后台 worker
生成 CSV。验收覆盖接单后断线、Relay 强制终止、服务双重启、查询暂不可见、
处理中、完成校验、拒绝和两个独立请求；同时检查任务数与 POST 请求数。

```powershell
corepack pnpm typecheck
node --test packages/mcp/dist/test/business-sandbox.test.js
# 可选：使用已有 Pi AISIX 配置，真实模型调用只接触合成业务数据
node examples/business-sandbox.mjs glm-5.3-flash
```

真实模型验收输出独立会话、各阶段 Relay 历史快照和 CSV 的证据目录。
没有 AISIX 配置时仍可运行上面的确定性业务测试。
范围、结果和已发现的模型兼容限制见
[业务沙箱验收](reports/BUSINESS_SANDBOX_ACCEPTANCE_2026-09-26.md)。

## MCP entry points (Claude Code, Codex, Pi)

`packages/mcp` exposes the same effect engine as a local stdio MCP server:

- only explicitly configured actions run (`<workspace>/.relay/mcp-actions.json`,
  schema `relay.mcp-actions/1`) — destinations and credentials never come from
  model text;
- one live server per workspace (single-writer lock; a second one fails
  closed until the first exits; the lock is recoverable after process death);
- unresolved operations are listable so fresh sessions reuse operation ids.

Host entries: `hosts/claude-code/relay-effect-guard` and
`hosts/codex/relay-effect-guard` (verified by real tool calls from both hosts
on one shared workspace). Protection applies **only** to actions executed
through the relay tools; raw shell/HTTP, built-in tools, and other MCP
servers are outside the guarantee.

## Status export (mat-console)

`relay status` emits a `mat-console.status/1` JSON document from a strictly
read-only open of the local effect journal — aggregate counts and attention
items only, no effect keys/ids/payloads. See `docs/STATUS-EXPORT.md`.

## Capsule data boundary

Relay does not automatically read environment values or unselected workspace
files into capsules. Journal payloads, artifact bytes, explicitly supplied adapter
files and capability configuration are caller-owned data that can be exported.
Review those inputs before sharing a capsule: Relay does not prove arbitrary
opaque bytes are secret-free. Migration requires a trusted, single-writer
workspace; cross-host failover and protection against arbitrary local writers
are outside v0.1.0.

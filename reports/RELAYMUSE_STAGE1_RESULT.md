# RELAYMUSE_STAGE1_RESULT — Devin self-verification (Codex independent acceptance pending)

Date: 2026-09-29 (rework after Codex rejection #1). Branch: `devin/stage-1-hardening` (base `2f8f046`). Scope: stage 1 only. No stage-2 work, no schedulers/event systems, no UI, no releases, no real external mutations.

**RESULT: PASS (self-verification only)** — on the scenarios actually exercised below. Codex's independent acceptance has NOT passed yet; this documents what Devin ran and verified. Uncovered boundaries are listed at the end.

### Rework items (Codex feedback on `7cb7c0c`)

- **Duplicate adapter waits (P1)**: consecutive `pending`/`failed` results previously parked a second `adapter:<id>` wait, which then blocked every later resume as a foreign blocker — the adapter was never re-polled. Now `resume()` collapses all adapter-owned waits under `adapter:<id>` to a single one (extras resolved — adapter-owned only) before the human/app blocker check, and reuses the existing wait instead of creating a new one.
- **FAILED slipped past completion (P1)**: `unsettledEffects` excluded `FAILED`, so `complete()` succeeded over a failed effect. `FAILED` is now unsettled → `complete()` throws `TaskUnsettledEffectsError` with the offending `key`/`status` list. FAILED stays terminal — never retried, journal never deleted.
- `reports/RELAYMUSE_COORDINATION.md` restored to the `main` version (coordination state is Codex-maintained).
- Report re-titled self-verification; the PASS below is Devin's run, not Codex acceptance.

## What was fixed (Codex findings 1–4)

### 1. `adapter.resume({resumed:false})` was ignored
- `AgentResumeResult` gains `status?: "completed" | "pending" | "idle" | "failed"`; a bare `{resumed:false}` maps to `pending`, `{resumed:true}` to `completed` (backwards compatible).
- `PiTaskAdapter` now reports honestly: `completed` when a deferred run finished, `pending` when still in flight after polling, `idle` for the legitimate no-deferred/no-session case (not a failure).
- `resume()` now, in order: terminal check → capability → effect reconciliation → **pending human/USER/non-adapter awaits gate** (Codex guardrail: `adapter.resume` is never invoked while a human approval or unrelated EXTERNAL await is pending) → `adapter.resume` → on `pending`/`failed` it parks an EXTERNAL await under the reserved ref `adapter:<adapter-id>` (`adapterWaitRef`) and returns `waiting`/`blocked` — durable across process restart. On `completed`/`idle` it resolves only that adapter-owned wait and proceeds to continuation. Unrelated EXTERNAL awaits are never auto-resolved.
- A `failed` adapter status parks the same adapter wait and returns `{outcome:"blocked", reason:"adapter"}` — recoverable, not terminal.

### 2. Approval bound to name only → bound to kind + canonical request hash
- `AwaitBinding {kind, requestHash}` is persisted on approval awaits (`binding_json` column; `hashRequest`/`stableStringify` — canonical, non-secret).
- `isApprovedFor` requires a RESOLVED APPROVAL await whose binding matches `spec.kind` AND `hashRequest(spec.request)`. Different request or kind → new approval wait. Legacy rows have NULL `binding_json` → treated as unbound → **fail closed**.
- Approval reason string now embeds `kind` and the first 12 hex chars of the request hash; `relay task approve` prints `kind=`/`requestHash=` per resolved wait so the approver sees exactly what was authorized.
- Duplicate approve stays idempotent; CONFIRMED effect re-entry stays deduplicated.

### 3. `complete()` only checked awaits → unsettled-effect gate
- `complete()` throws `TaskUnsettledEffectsError` when any journal row is `PREPARED|SUBMITTED|UNKNOWN|FAILED` — the task can never report success over a failed/unknown effect. Recovery path preserved (`resume` reconciles first).
- `examples/pi-muse/pi-muse-runtime.mjs` now writes the success receipt/decision and calls `complete()` only when the publish outcome is `executed` + `confirmed`; otherwise it prints `publish not confirmed (...)` and leaves the task resumable.
- Read-only reconciliation of SUBMITTED/UNKNOWN runs **before** the approval gate (reconciliation never re-executes, never re-POSTs, and must not demand a fresh approval); no execution while approval is pending.

### 4. Non-atomic `insertAwait` + `WAITING` transition → single `parkAwait`
- New `TaskStore.parkAwait(taskId, await_, at, events?)` — await row + event append + status transition in **one transaction**, guarded to `ACTIVE|WAITING` sources; returns the post-update task, or `undefined` when the guard rejected (terminal/missing task). Implemented in `MemoryTaskStore` and `SqliteTaskStore` (`BEGIN…COMMIT`, rollback on failure).
- `createAwait` now uses `parkAwait`, so a crash cannot leave `ACTIVE` + pending await: reopening the DB never exposes the split state.
- `runTaskEffect` throws `TaskAwaitPendingError` when non-adapter awaits are pending (effect execution respects parked waits), while CONFIRMED/FAILED journal re-entry and read-only reconcile remain reachable.
- No new `relay_task_events.type` values — existing CHECK constraint on legacy DBs is untouched.

## Commands / exit codes / counts

| Command | Runtime | Exit | Result |
|---|---|---|---|
| `pnpm check` (typecheck `tsc -b` + `pnpm -r test`) | Node v24.19.0, pnpm 10.33.0 | 0 | 261 pass / 0 fail (baseline 226 + 35 new) |
| `pnpm check` | Node v22.23.3, pnpm 10.33.0 | 0 | 261 pass / 0 fail |

Per-package (both runtimes): epistemic 8, core 68, artifact-fs 12, storage-sqlite 45, cli 65, mcp 55, adapter-pi 8 — all `ℹ fail 0`.
GitHub CI matrix on the pushed head: ubuntu+windows × node 22/24 — see the PR checks for the live result.

New behavioral tests were written first and confirmed red before implementation (20+ assertions across the four findings).

## Cross-process / acceptance coverage actually exercised

`packages/cli/test/task.test.ts` "relay task stage-1 hardening (cross-process)" — real child CLI processes against `node:sqlite` stores, marker files count remote mutations:

- **Approval request drift**: ask request A → approve → new process, same name request B → B is NOT executed; new bound approval wait required; `task approve` prints `requestHash=`; after approving the drifted wait, remote mutation count = exactly 1.
- **Slow/pending deferred**: adapter `resume` → `pending` → EXTERNAL wait `adapter:pi` parked, task exits `waiting` (exit 1), no continuation; a later `resume` resolves it and continuation runs once (`adapterCalls===2`, `continued===1`).
- **pending→pending→completed** (cross-process, NEW): each `task resume` is a separate process on the same `storage.db`; adapter polled on every resume (`polls` 2 → 3), exactly one `adapter:pi` EXTERNAL wait persisted throughout, cleared on completion, continuation ran exactly once.
- **failed→failed→completed** (cross-process, NEW): same shape with `status:"failed"` — each resume exits blocked (non-zero), adapter re-polled, single wait kept, third resume completes, continuation once.
- **Legacy duplicate adapter waits** (cross-process, NEW): module seeds two `adapter:pi` waits + one `app:webhook` EXTERNAL wait; resume collapses the adapter dupes to one and leaves the app wait PENDING — `adapter.resume` is never invoked while it gates.
- **FAILED refuses completion across restarts** (cross-process, NEW): publish `execute` throws → outcome `failed`; two separate `task resume` processes both print `complete refused`, remote marker stays 1 (no blind retry), task never COMPLETED.
- **Crash after remote commit, POST=1** (cross-process, NEW): module `execute` performs a real HTTP `POST /publish` to the controlled fixture server, then self-`SIGKILL`s before returning — journal holds only SUBMITTED, server `publishRequests=1, mutations=1`. Fresh-process `task resume` reconciles via `GET /effects/:key` (read-only) → CONFIRMED → continuation → receipt + `complete()`. Final `publishRequests=1` — zero duplicate remote mutations.
- **SIGKILL atomic park**: child killed with real `SIGKILL` mid-park; reopened DB shows `WAITING` + exactly 1 wait row — never `ACTIVE` + pending await.
- **UNKNOWN blocks completion**: `complete` refused while journal holds UNKNOWN; restart `resume` reconciles read-only (remote POST count stays 1), then completes; CONFIRMED stays deduplicated.
- **Continuation-hits-UNKNOWN**: refused completion surfaces `complete refused`.
- **FAILED publish (pi-muse module)**: `MUSE_RELEASE_KEY=fail-1` → server 500 → `publish not confirmed`, no success receipt/decision artifacts, task not COMPLETED, no mutations.

Unit level (`packages/core/test/task.test.ts`): adapter resume semantics (6), approval binding incl. legacy-unbound fail-closed (4), completion gate (4), `runTaskEffect` refusal while parked (1); adapter-pi tests assert `completed` status on both first and second resume with `submissions()===1` (no second agent job submission). `packages/storage-sqlite/test/task-store.test.ts`: atomic parking suite (5) — commit+reopen, terminal guard returns undefined with nothing committed, rollback on bad event, binding persistence, legacy-table migration.

## Changed files (implementation + tests)

```
examples/pi-muse/fixtures/release-server.mjs    |   5 +
examples/pi-muse/pi-muse-runtime.mjs            |  14 +-
packages/adapter-pi/src/task-adapter.ts         |  18 +-
packages/adapter-pi/test/task-adapter.test.ts   |   6 +
packages/cli/src/task.ts                        |   9 +
packages/cli/test/task.test.ts                  | 378 +++++++++-
packages/core/src/index.ts                      |   4 +
packages/core/src/task.ts                       | 272 ++++++--
packages/core/test/task.test.ts                 | 419 ++++++++++
packages/storage-sqlite/src/task-store.ts       |  91 +--
packages/storage-sqlite/test/task-store.test.ts | 150 +++-
reports/RELAYMUSE_STAGE1_RESULT.md              |  this file
```

## Uncovered boundaries / limitations

- **Not exercised**: concurrent `resume`/`runTaskEffect` on the same task row (stage 2: task-level concurrency); TIME await scheduling (schema seam only); `--adapter-module` remote URLs (local paths only); real network partition during a live adapter poll (simulated via poll-count fixtures); Pi replay semantics beyond installed public APIs.
- `parkAwait` guard covers terminal/missing tasks; SQLite write-lock contention across two simultaneous writers is not stress-tested.
- **Runtime matrix**: Node v22.23.3 + v24.19.0 on Linux x64 both ran the full suite green. Node 22 was installed manually to `~/.local/node22` (official tarball, SHA256 verified) — nvm is present but its `nvm install` subcommand is broken on this VM.
- **Tooling discrepancy (preserved per instruction)**: UI session selection is SWE-2 High, but the public API reports this session's agent as `swe-2-max`; no verified model parity is claimed.
- No credentials/secrets are persisted in the new `binding_json` column, events, logs, or capsules — bindings carry only `kind` + SHA-256 request hash.

## Legacy compatibility

`binding_json` is added via `ALTER TABLE` guarded by `PRAGMA table_info` on open; pre-existing DBs open without migration scripts, NULL bindings fail closed by design, and the `relay_task_events.type` CHECK constraint is unchanged.

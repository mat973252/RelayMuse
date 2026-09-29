# RelayMuse Stage 2 — Result

**Status: Devin self-verification.** Codex has not independently accepted this head yet.

- Base: `origin/main` @ `f390f62` (stage-1 merge)
- Branch: `devin/stage-2-hardening`
- Date: 2026-09-29 (UTC)
- Environments verified locally: Linux, Node 24.19.0 and Node 22.23.3, pnpm 10.33.0
- Model note (recorded, unresolved): web UI selected SWE-2 High; the public API reports `swe-2-max`. No parity claim is made.

## Item 1 — portable default demo

- `examples/pi-muse/demo.mjs` keeps child stdout and stderr in separate buffers; `task show` JSON is parsed from stdout only; stderr is surfaced as failure diagnostics.
- The doctor leg builds PATH with `path.delimiter` (`:` on POSIX, `;` on win32) instead of a hard-coded `:`.
- Kill check is platform-aware: POSIX asserts `signal === "SIGKILL"`; Windows asserts `signal === null && status !== 0`. Real process death is required — no `NODE_NO_WARNINGS` or equivalent used as a fix.
- Every check prints diagnostics on failure; a failing run re-prints all failed checks to stderr at the end.
- Crash evidence is combined: real process death + `kill-intent` marker written at the expected crash point + no `after-kill` marker + remote commit verified. A plain non-zero exit (unknown task → exit 66) is asserted NOT to satisfy the predicate, so a normal error exit cannot masquerade as a kill.
- Evidence: `node examples/pi-muse/demo.mjs` → **exit 0**, 41/41 checks, remote state `{"submissions":2,"publishRequests":2,"mutations":2,"publishedKeys":["release-pkg-1","release-pkg-2"]}` (Node 24.19.0, Linux).

## Item 2 — release readiness from a real package test

- `examples/pi-muse/pi-muse-runtime.mjs` writes a synthetic package (`.relay/pkg/package.json` + `.relay/pkg/test.mjs`) and **really runs** `node test.mjs` via `spawnSync` in a child process.
- The evidence artifact records the real command, exit code, started/finished timestamps, and full stdout/stderr (plus their sha256 digests).
- The `releasable` belief is **derived**: `status = check.pass ? "accepted" : "rejected"`. On failure `runtime.blockTask` marks the task BLOCKED — no approval gate, no publish decision, no receipt.
- `continuation()` re-reads `beliefFor(claim-<id>)` after the adapter leg and refuses to publish when the belief is not `accepted` (defense in depth).
- Controllable failure leg: `MUSE_PKG_FAIL=1` makes `test.mjs` exit 1. New CLI test `pi-muse release readiness (stage 2)` exercises it end to end: run exits 2 / BLOCKED, belief rejected, remote `publishRequests=0`/`mutations=0`, resume prints `publish refused`, no `generated` artifact. It also reads the evidence artifact directly and asserts `command=...test.mjs`, `exitCode=1`, `result=fail`.
- The synthetic package and mock provider are explicitly labeled fixtures; nothing is presented as a real model or real release.

## Item 3 — real artifact lineage

- One lineage system (`ArtifactStore` `parents` + `lineage()`); no second mechanism added.
- Chain: **package manifest** (role `input`) → **test evidence** (role `evidence`, `parents: [pkgRecord.id]`) → **publish receipt** (role `generated`, `parents: [evidenceRecord.id]`).
- The demo verifies via `store.resolve` + `store.lineage` that `receipt.parents === [evidence]` and `evidence.parents === [pkg]`, that `lineage.problems` is empty, that evidence content literally contains `command=` and `exitCode=0`, and that `store.verify()` reports no integrity problems — across SQLite close/reopen (fresh `task show` in a new process).

## Item 4 — minimal single-writer task lock

- New `relay_task_run_leases` table (`task_id` PK, `owner_id`, `owner_pid`, `acquired_at`) in the same `storage.db`; `MemoryTaskStore` got an equivalent in-memory implementation.
- `resume()` claims an atomic lease after a fast-path terminal check, **re-reads the task under the lease** (the pre-claim read is only a fast path: a contender paused before claiming gates on the fresh snapshot, so a stale `ACTIVE` can never reach adapter or continuation), runs the entire recovery→adapter→continuation window under it, and releases in `finally`. A live contention returns `{outcome:"busy"}` → CLI prints `busy <id> owner-pid=N` and exits **2** (non-success), without invoking adapter or continuation.
- Reclaim is pid-liveness based (`process.kill(pid, 0)`, EPERM = alive) plus a guarded `expectedOwnerPid` conditional update — a dead owner is reclaimed, a live owner is never overwritten, and two racing reclaimers cannot both win. No pure-timeout steal. The guarded update is a CAS guard between contenders only: it does NOT identify process generations. If a dead owner's pid is reused by a different live process, the lease looks owned by a live process and `resume` reports `busy` — honest limitation, see boundaries.
- Read-only `task show`/`list`/`approve` remain available while the lease is held (verified in the race test).
- Scope: same machine / shared workspace only. This is **not** a cross-machine distributed lock.
- Verified with real child processes: two `resume` children racing → exactly one continuation, loser exits 2; delayed-claim stale snapshot (COMPLETED: loser exits 0 `completed (already)`; CANCELLED: exits 2 `cancelled`) → adapter-calls=1/0, continued=1/0; `SIGKILL`ed owner → recovery resume completes once; `publishRequests=1`, `mutations=1`. The claim delay is a `claimDelayMs` resume option surfaced via `RELAY_TEST_LEASE_CLAIM_DELAY_MS` (test-only seam; env read stays in `cli/src/env.ts` per the workspace boundary).
- Existing gates (UNKNOWN/FAILED/approval/adapter-await) are unchanged — the lease only wraps them.

## Item 5 — CI

- Reused the existing matrix `os:[ubuntu,windows] × node:[22,24]`; added one step `node examples/pi-muse/demo.mjs` (existing `pnpm check` already covers the new negative tests). No new matrix claimed.

## Commands / exit codes actually run (Devin self-verification)

| Command | Runtime | Exit | Result |
|---|---|---|---|
| `pnpm check` | Node 24.19.0, Linux | 0 | 277 pass / 0 fail |
| `pnpm check` | Node 22.23.3, Linux | 0 | 277 pass / 0 fail |
| `node examples/pi-muse/demo.mjs` | Node 24.19.0, Linux | 0 | 41/41 checks, remote POST counts correct |
| `node --test dist/test/task.test.js` (cli) | Node 24.19.0 | 0 | 21/21 incl. lock race, stale-claim (completed/cancelled), crash reclaim, readiness-fail |
| `node --test dist/test/task.test.js` (core) | Node 24.19.0 | 0 | 35/35 incl. stale-snapshot in both terminal states |
| `node --test dist/test/task-store.test.js` (sqlite) | Node 24.19.0 | 0 | 14/14 incl. cross-reopen lease persistence |

## Uncovered boundaries

- Lease reclaim relies on `kill(pid,0)` liveness. `expectedOwnerPid` only prevents two concurrent reclaimers from both winning (CAS); it does NOT detect pid reuse — a pid recycled by an unrelated live process makes the stale lease look owned, so resumes report `busy` until that process exits or the lease row is removed manually. Not a distributed lock — same host, shared `storage.db` only.
- The synthetic package test is a real child `node test.mjs` run, but the package and provider are fixtures; no real model or real release service is exercised.
- Demo runs against a local HTTP fixture server (`connection: close` mitigation from stage 1 retained).
- Windows coverage for the new tests is CI-only; local verification was Linux-only.
- UI shows SWE-2 High while API reports `swe-2-max`; discrepancy preserved, not resolved.

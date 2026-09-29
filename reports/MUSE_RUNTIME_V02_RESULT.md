# Relay v0.2 — Muse-style Durable Personal Agent Runtime — RESULT

## Result: PASS

`pnpm check` green (226 tests, 0 failures — 206 baseline + 20 new), and the
real vertical slice `node examples/pi-muse/demo.mjs` passes 33/33 checks with
real process kills between every step.

## User-visible capability

A `relay task` command family over the same `.relay/storage.db`:

```
relay task run --agent pi --adapter-module <app.mjs> "<goal>"
relay task list | show <id> | events <id>
relay task approve <id> [--ref <name>]
relay task resume <id> [--adapter-module <app.mjs>]
relay task create | cancel
```

Each invocation is a separate process; a task created by one survives every
subsequent one. `run` starts the agent leg (Pi `AgentSession` via
`PiTaskAdapter.attach`) and lets the app module persist evidence + reach an
approval-gated effect. `approve` resolves APPROVAL awaits idempotently.
`resume` walks the fixed recovery gate — task load → capability check →
unsettled effects (reconcile, never blind retry) → unresolved awaits →
`agentRef` → `adapter.resume` (Pi `fetchDeferred`) → app `continuation`.

## Vertical slice (examples/pi-muse, per-step evidence)

Real run from `/tmp/muse-evidence` capture (task `e54b9c74-2cee-4e59-9098-c1774c07bdb7`):

| Step | Command / action | Evidence |
| --- | --- | --- |
| CREATE | `task run … "release pkg-ev"` | `task e54b9c74…`; TASK_CREATED committed |
| RUN | agent leg + evidence + gate | `agent attached: …/01a0e76e-….jsonl`; `publish decision: awaiting-approval` |
| WAIT | process exit | `status WAITING (waiting on APPROVAL)`; await `9f363519-…` PENDING |
| KILL | child exits / SIGKILL leg | demo task 2: `signal=SIGKILL` inside `execute()` after remote commit |
| RESTART | `task list`, `task show` | task still WAITING; snapshot derives `waitingFor[0].kind="APPROVAL"` |
| (premature resume) | `task resume` before approve | `blocked … reason=await-pending`, exit 1, remote mutations still 0 |
| APPROVE | `task approve` ×2 | `resolved-awaits 1`, then `resolved-awaits 0` (no-op) |
| RESUME | `task resume` | gate passes; `resumed … deferred run completed` |
| EFFECT | publish spec | journal: `PREPARED:prepare → SUBMITTED:submit → CONFIRMED:execute` |
| VERIFY | `task show`, `task events`, `effects --history` | snapshot COMPLETED; 11 ordered task events; history coverage `observed` |
| COMPLETE | continuation | TASK_COMPLETED; receipt artifact linked; decision recorded |

Crash leg (task 2 in demo.mjs): resume child SIGKILLed **after** the remote
commit → journal row left `SUBMITTED`; next `resume` reconciled via
`GET /effects/:key` → `CONFIRMED`. No re-POST.

## Tests

Command: `pnpm check` (with `packages/adapter-pi/node_modules/.bin` on PATH,
same as CI — provides the `pi` binary).

Exit: 0. Passed: **226** (epistemic 8, core 49, artifact-fs 12,
storage-sqlite 40, cli 54, mcp 55, adapter-pi 8). Failed: 0.

New tests (20): core `test/task.test.ts` 9 (AC-03/04/05/06/08, Rule 1
reconcile, Rule 4 idempotent resolve, derived snapshot, terminal guards,
event chain); storage-sqlite `test/task-store.test.ts` 5 (AC-01/02,
guarded-transition atomicity, links, shared DB file); adapter-pi
`test/task-adapter.test.ts` 1 (real Pi session attach → restart →
fetchDeferred resume, submissions == 1); cli `test/task.test.ts` 5
(cross-process create/list/show/cancel, 66s, adapter-module seam).

AC mapping: AC-01/02 store tests; AC-03/04/05/06/08 core tests + demo legs;
AC-07 crash-ambiguity — demo task-2 SIGKILL leg; AC-09/10/11 covered by
snapshot assertions (artifacts + digest refs, investigation claims, no
credential fields in persisted rows — `agentRef` stores session file paths
and job ids only); AC-12 `pnpm check` green.

## Effect proof

From `release-server /state` at slice end (two tasks):

```json
{"submissions":2,"publishRequests":2,"mutations":2,"publishedKeys":["release-pkg-1","release-pkg-2"]}
```

- Logical effect count (task-scoped keys): 2 — `task/<id1>/publish`, `task/<id2>/publish`
- Remote publish REQUESTS: 2 (exactly one POST per logical effect — approve
  path executed once; crash path committed once, confirmed via reconcile)
- Remote MUTATIONS: 2 (one per key; server dedup by key never triggered by us)
- Resume count: 5 child resumes total (1 blocked prematurely, 2 successful,
  1 no-op on terminal, 1 SIGKILLed mid-commit) + 2 adapter-level deferred
  completions
- Restart count: 10+ CLI child processes; the task under test never lost a
  committed mutation

## Durable proof (before/after restart, task e54b9c74)

| Field | After WAIT | After COMPLETED |
| --- | --- | --- |
| task id | `e54b9c74-2cee-4e59-9098-c1774c07bdb7` | same |
| status | WAITING | COMPLETED |
| await | `9f363519-5ad5-4d46-9052-44fbef74cb7e` PENDING (APPROVAL, ref=publish) | RESOLVED |
| agent ref | `sessionId 01a0e76e-…`, sessionFile `…/01a0e76e-….jsonl`, deferredRef `job-1` | unchanged (reference, not copy) |
| effect | none yet (not PREPARED until approved) | `556689c2-…` key `task/e54b9c74…/publish` CONFIRMED |
| artifacts | `artifact://sha256/b1541c…` (evidence) | + `artifact://sha256/574afb…` (generated receipt) |
| investigation | `inv-e54b9c74-…` open, claim accepted | + decision `release … approved and published` resolved |

## Changed files

```
packages/core/src/task.ts              new — DurableTask domain, TaskStore/AgentAdapter/
                                         TaskEpistemicReader ports, TaskRuntime
                                         (awaits, approval gate, recovery protocol,
                                         derived snapshot), MemoryTaskStore
packages/core/src/index.ts             export task module
packages/core/test/task.test.ts        new — 9 domain tests
packages/storage-sqlite/src/task-store.ts  new — SqliteTaskStore (5 tables in
                                         .relay/storage.db, WAL+FULL, atomic
                                         row+event commits, guarded transitions)
packages/storage-sqlite/src/index.ts   export SqliteTaskStore
packages/storage-sqlite/test/task-store.test.ts  new — 5 persistence tests
packages/adapter-pi/src/task-adapter.ts    new — PiTaskAdapter (AgentAdapter impl)
packages/adapter-pi/src/index.ts       export PiTaskAdapter
packages/adapter-pi/test/task-adapter.test.ts  new — 1 real-Pi test
packages/cli/src/task.ts               new — `relay task` subcommands +
                                         --adapter-module app seam
packages/cli/src/cli.ts                dispatch + usage
packages/cli/test/task.test.ts         new — 5 CLI tests
examples/pi-muse/{README.md,demo.mjs,pi-muse-runtime.mjs,fixtures/release-server.mjs}
tasks/NEXT_ITERATION_MUSE_RUNTIME_V02.md   the executed plan
reports/MUSE_RUNTIME_V02_BASELINE.md       baseline audit
reports/MUSE_RUNTIME_V02_RESULT.md         this file
```

## Architectural boundary review

- Dependency direction preserved: `@relay/core` owns the task domain;
  `storage-sqlite` implements TaskStore in the same DB file; `adapter-pi`
  implements AgentAdapter via public Pi APIs only; `cli` wires them. No new
  packages, no cycles (`adapter-pi` is never imported by core/cli — the
  `--adapter-module` dynamic import keeps app code the integration point).
- Pi untouched: no fork, no loop reimplementation, no second
  session/DeferredHandle primitive — `agentRef` stores references only.
- Effect Guard is a real boundary: `runTaskEffect` refuses non-ACTIVE tasks,
  routes approval-gated effects to APPROVAL awaits, and SUBMITTED/UNKNOWN
  records can only re-enter through reconcile — enforced in core, not in
  prompt text.
- Derived, never narrated: snapshots compose only persisted rows (tasks,
  awaits, journal, links, epistemic claims/beliefs/decisions). No stored
  prose, no percentages.
- Secrets: no credential fields anywhere in the new schema; the demo provider
  is a local mock with an ambient stub.

## Known gaps

- TIME/EXTERNAL await kinds exist in the schema as the extension seam only —
  no timer/external trigger implementation (per spec: schema seam only).
- `--adapter-module` is a local-file seam (path or file: URL) — fine for
  examples; a packaged app would resolve installed modules instead.
- `task resume` has no advisory task lock; two operators resuming one task
  concurrently is guarded at the effect-journal level (runEffect dedup) but
  not at the task-row level.
- Epistemic spine is wired for the happy path (claims/evidence/beliefs/
  decision); delta/attention integration for task state changes is minimal.
- `relay run` sugar command not added (spec marked optional).

## Next milestone (≤3)

1. v0.3: real Pi provider path — run the slice against a real model with a
   real DeferredHandle provider; TIME/EXTERNAL await resolution services.
2. Task-scoped locking + multi-await ordering; `relay run` sugar.
3. Delta→attention wiring for task status transitions and reconciliation
   outcomes.

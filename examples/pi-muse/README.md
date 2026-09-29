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
| `demo.mjs` | orchestrator: starts the release server, spawns each `relay task …` command as a **separate child process**, asserts 33 checks, prints PASS/FAIL |
| `pi-muse-runtime.mjs` | the app-side module loaded by `--adapter-module`: `adapter` (PiTaskAdapter + mock deferred provider), `effects` (approval-gated publish spec with reconcile), `run` (check package → artifact evidence → ASK), `continuation` (publish → receipt artifact → decision → complete) |
| `fixtures/release-server.mjs` | local, fully observable "remote": deferred jobs (`POST /js`, `GET /js/:id`), counted mutations (`POST /publish`), reconcile probe (`GET /effects/:key`), `GET /state` |

## Run it

```sh
pnpm install && pnpm check   # build all packages first
node examples/pi-muse/demo.mjs
```

Expected tail:

```
=== SLICE PASS — 33/33 checks ===
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
- Secrets are never serialized; the demo uses a local mock provider with an
  ambient credential stub.

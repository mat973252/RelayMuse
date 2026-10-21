# Task execution and terminal transitions

TaskRuntime uses two independent, machine-local durable leases:

- The run lease admits one resume (recovery, adapter, continuation) at a time.
- The execution lease admits one task effect or completion check at a time.
  A continuation may call `runTaskEffect` and `complete` without reacquiring its
  run lease. Concurrent effect/completion callers fail with
  `TaskExecutionBusyError`; the runtime does not automatically retry them.

Execution admission checks the expected task status and writes the lease in a
single short store transaction. Completion holds that same lease while checking
awaits and journal facts and committing its terminal transition. This covers the
window before an effect has written PREPARED. The completion commit also refuses
any pending await created after the initial check. SQLite transactions never
span adapter, execute, or reconcile network awaits.

Cancellation commits immediately without waiting for an execution lease. A
cancelled task cannot admit a new effect. An effect admitted before cancellation
may still execute and settle: cancellation cannot retract an external request.
Its journal retains CONFIRMED, FAILED, or UNKNOWN independently of CANCELLED.
SUBMITTED/UNKNOWN still require read-only reconciliation and are never replayed.

After an asynchronous adapter result, resume checks durable terminal status.
Continuation admission uses a guarded TASK_RESUMED commit; if cancellation wins
that commit, no continuation runs. A continuation admitted first may already be
running when cancellation commits; subsequent task effects are still gated.
An unsuccessful await park never returns a fictitious await.

Execution leases survive process death. Runtime recovery probes the recorded
PID and reclaims only a dead owner's exact owner id; old releases cannot delete
a successor. Reclaim does not clear or authorize replay of journal records.
PID reuse may conservatively leave a lease busy; this is a local-workspace
mechanism, not distributed fencing.

SQLite adds `relay_task_execution_leases` on open without rewriting task or
effect history. Custom TaskStore implementations must implement atomic
`claimExecutionLease`, owner-guarded `releaseExecutionLease`, and the pending-await
guard on COMPLETED transitions. Stop old runtime writers before upgrading:
older binaries do not participate in this admission protocol.

Only TaskRuntime-mediated actions receive these gates. Arbitrary external calls
inside application callbacks remain the application's responsibility.

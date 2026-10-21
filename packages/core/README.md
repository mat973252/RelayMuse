# @mat973252/relay-core

Relay core: durable execution continuity for AI agents. MIT licensed.

Requires Node 22.13+ (Node 24 recommended).

See the [installation and usage guide](https://github.com/mat973252/Relay/blob/main/docs/NPM-USAGE.md).

Only configured Relay actions are protected. Ambiguous effects stay UNKNOWN until reconciliation. Caller-owned capsule data must be reviewed for secrets.

Task effects and completion share a machine-local execution lease. Concurrent
callers receive `TaskExecutionBusyError`; cancellation stops new admissions while
already admitted effects retain their real results. See the
[task concurrency contract](../../docs/TASK_EXECUTION_CONCURRENCY.md).

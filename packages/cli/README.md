# @mat973252/relay-cli

Relay cli: durable execution continuity for AI agents. MIT licensed.

Requires Node 22.13+ (Node 24 recommended).

See the [installation and usage guide](https://github.com/mat973252/Relay/blob/main/docs/NPM-USAGE.md).

Only configured Relay actions are protected. Ambiguous effects stay UNKNOWN until reconciliation. Caller-owned capsule data must be reviewed for secrets.

`task run` and a resumed continuation return an exit code based on the final
durable task status: ACTIVE/COMPLETED = 0, WAITING = 1, BLOCKED/CANCELLED = 2.
Code 0 permits an ACTIVE task; it does not prove the task is complete. A
continuation that creates another wait returns 1 even after it was resumed.
Unknown tasks return 66; usage errors return 64. Query commands still return 0
when the query succeeds, including when showing a WAITING task.

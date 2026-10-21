# @mat973252/relay-adapter-pi

Relay adapter-pi: durable execution continuity for AI agents. MIT licensed.

Requires Node 22.13+ (Node 24 recommended).

See the [installation and usage guide](https://github.com/mat973252/Relay/blob/main/docs/NPM-USAGE.md).

Only configured Relay actions are protected. Ambiguous effects stay UNKNOWN until reconciliation. Caller-owned capsule data must be reviewed for secrets.

Both persisted and deferred task results require final assistant text containing
non-whitespace characters before completion. An empty deferred final result
returns `failed` immediately and cannot authorize the application continuation;
valid output is returned unchanged.

Only a `deferred` response remains pending during polling. Error, aborted,
length-limited or unfinished tool results return `failed` immediately without
automatic polling retries. Details expose the stop reason, not provider error
payloads; a later explicit resume can retry the same persisted job reference.

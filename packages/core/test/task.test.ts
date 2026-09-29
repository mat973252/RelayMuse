/**
 * TaskRuntime domain acceptance (v0.2):
 *   AC-03 pending await blocks resume (agent never invoked)
 *   AC-04 approval-gated effect does not execute before approval
 *   AC-05 approve + resume executes exactly once
 *   AC-06 double resume still executes exactly once
 *   AC-08 missing required capability blocks resume (task -> BLOCKED)
 *   Rule 1 UNKNOWN effect -> reconciliation, never blind retry
 *   Rule 4 double await-resolve is a no-op
 *   derived snapshot fields come from facts only
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AmbiguousEffectError,
  MemoryTaskStore,
  TaskRuntime,
  hashRequest,
  type AgentAdapter,
  type AgentResumeResult,
  type EffectJournal,
  type EffectRecord,
  type EffectStatus,
  type EffectTransitionCause,
  type TaskEffectSpec,
} from "../src/index.js";

class MemoryEffectJournal implements EffectJournal {
  private readonly byId = new Map<string, EffectRecord>();
  private readonly byKey = new Map<string, string>();
  private clock = 10_000;
  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  async insertPrepared(record: EffectRecord): Promise<void> {
    this.byId.set(record.id, { ...record, status: "PREPARED" });
    this.byKey.set(record.key, record.id);
  }

  private update(id: string, from: EffectStatus[], patch: Partial<EffectRecord>): void {
    const record = this.byId.get(id);
    if (record === undefined || !from.includes(record.status)) {
      throw new Error(`invalid effect transition from ${record?.status ?? "missing"}`);
    }
    this.byId.set(id, { ...record, ...patch, updatedAt: this.tick() });
  }

  async markSubmitted(id: string, at: number, _cause?: EffectTransitionCause): Promise<void> {
    this.update(id, ["PREPARED"], { status: "SUBMITTED", submittedAt: at });
  }

  async markConfirmed(
    id: string,
    patch: { remoteRef: string | undefined; resultJson: string | undefined; at: number; cause?: EffectTransitionCause },
  ): Promise<void> {
    this.update(id, ["SUBMITTED", "UNKNOWN"], {
      status: "CONFIRMED",
      remoteRef: patch.remoteRef,
      resultJson: patch.resultJson,
      settledAt: patch.at,
    });
  }

  async markFailed(id: string, reason: string, at: number, _cause?: EffectTransitionCause): Promise<void> {
    this.update(id, ["SUBMITTED", "UNKNOWN"], { status: "FAILED", reason, settledAt: at });
  }

  async markUnknown(id: string, reason: string, at: number, _cause?: EffectTransitionCause): Promise<void> {
    this.update(id, ["SUBMITTED", "UNKNOWN"], { status: "UNKNOWN", reason });
  }

  async get(id: string): Promise<EffectRecord | undefined> {
    const record = this.byId.get(id);
    return record === undefined ? undefined : { ...record };
  }

  async getByKey(key: string): Promise<EffectRecord | undefined> {
    const id = this.byKey.get(key);
    return id === undefined ? undefined : this.get(id);
  }

  async list(): Promise<EffectRecord[]> {
    return [...this.byId.values()].map((r) => ({ ...r }));
  }
}

interface Rig {
  runtime: TaskRuntime;
  store: MemoryTaskStore;
  journal: MemoryEffectJournal;
  adapterCalls: { resume: number };
}

function rig(capabilities?: () => Promise<"READY" | "DEGRADED" | "BLOCKED">): Rig {
  const store = new MemoryTaskStore();
  const journal = new MemoryEffectJournal();
  const adapterCalls = { resume: 0 };
  const runtime = new TaskRuntime({
    store,
    journal,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  void adapterCalls;
  return { runtime, store, journal, adapterCalls };
}

function countingAdapter(calls: { resume: number }): AgentAdapter {
  return {
    id: "pi",
    resume: async () => {
      calls.resume += 1;
      return { resumed: true };
    },
  };
}

function publishSpec(counters: { remote: number }, opts: { approvalRequired?: boolean; hold?: boolean } = {}): TaskEffectSpec {
  return {
    name: "publish",
    kind: "http/publish",
    request: { release: "pkg-1" },
    approvalRequired: opts.approvalRequired ?? false,
    execute: async () => {
      counters.remote += 1;
      return { remoteRef: "pub-1" };
    },
    reconcile: async () => ({ found: true, remoteRef: "pub-1", result: { value: 1 } }),
  };
}

describe("TaskRuntime lifecycle", () => {
  it("create -> await -> WAITING -> resolve -> resume -> ACTIVE", async () => {
    const { runtime, adapterCalls } = rig();
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const await_ = await runtime.createAwait(task.id, { kind: "USER", reason: "need input" });
    assert.equal((await runtime.getTask(task.id))?.status, "WAITING");

    const blocked = await runtime.resume(task.id, { adapter: countingAdapter(adapterCalls) });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(adapterCalls.resume, 0, "agent must not run while an await is pending (AC-03)");

    assert.equal(await runtime.resolveAwait(await_.id), "resolved");
    assert.equal(await runtime.resolveAwait(await_.id), "already-resolved", "Rule 4: no-op");

    const resumed = await runtime.resume(task.id, { adapter: countingAdapter(adapterCalls) });
    assert.equal(resumed.outcome, "resumed");
    assert.equal(adapterCalls.resume, 1);
    assert.equal((await runtime.getTask(task.id))?.status, "ACTIVE");
  });

  it("AC-04/05: approvalRequired effect waits, then executes exactly once", async () => {
    const { runtime, adapterCalls } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });

    const first = await runtime.runTaskEffect(task.id, publishSpec(counters, { approvalRequired: true }));
    assert.equal(first.decision, "awaiting-approval");
    assert.equal(counters.remote, 0, "approval pending -> remote count stays 0 (AC-04)");
    assert.equal((await runtime.getTask(task.id))?.status, "WAITING");

    // Resume while approval is pending is blocked.
    const blocked = await runtime.resume(task.id, {
      adapter: countingAdapter(adapterCalls),
      effects: [publishSpec(counters, { approvalRequired: true })],
    });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(counters.remote, 0);

    await runtime.approve(task.id);
    const resumed = await runtime.resume(task.id, {
      adapter: countingAdapter(adapterCalls),
      effects: [publishSpec(counters, { approvalRequired: true })],
      continuation: async (ctx) => {
        const outcome = await ctx.runtime.runTaskEffect(ctx.task.id, publishSpec(counters, { approvalRequired: true }));
        assert.equal(outcome.decision, "executed");
      },
    });
    assert.equal(resumed.outcome, "resumed");
    assert.equal(counters.remote, 1, "approve + resume -> exactly one remote mutation (AC-05)");
    assert.equal(adapterCalls.resume, 1);
  });

  it("AC-06: double resume cannot duplicate the effect", async () => {
    const { runtime, adapterCalls } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.runTaskEffect(task.id, publishSpec(counters, { approvalRequired: true }));
    await runtime.approve(task.id);

    const runOnce = {
      adapter: countingAdapter(adapterCalls),
      effects: [publishSpec(counters, { approvalRequired: true })],
      continuation: async (ctx: { task: { id: string }; runtime: TaskRuntime }) => {
        await ctx.runtime.runTaskEffect(ctx.task.id, publishSpec(counters, { approvalRequired: true }));
        await ctx.runtime.complete(ctx.task.id);
      },
    };
    const first = await runtime.resume(task.id, runOnce);
    assert.equal(first.outcome, "resumed");
    assert.equal((await runtime.getTask(task.id))?.status, "COMPLETED");

    const second = await runtime.resume(task.id, runOnce);
    assert.equal(second.outcome, "completed");
    assert.equal(counters.remote, 1, "double resume never duplicates the mutation (AC-06)");
    assert.equal(adapterCalls.resume, 1, "adapter not invoked again on a terminal task");
  });

  it("AC-08: missing required capability parks the task BLOCKED", async () => {
    const { runtime, store, adapterCalls } = rig(async () => "BLOCKED");
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const outcome = await runtime.resume(task.id, { adapter: countingAdapter(adapterCalls) });
    assert.equal(outcome.outcome, "blocked");
    assert.equal((await store.getTask(task.id))?.status, "BLOCKED");
    assert.equal(adapterCalls.resume, 0, "adapter must not run under capability drift");
  });

  it("Rule 1: UNKNOWN effect routes to reconciliation, never a blind retry", async () => {
    const { runtime, journal } = rig();
    const counters = { remote: 0, reconciled: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const spec: TaskEffectSpec = {
      name: "publish",
      kind: "http/publish",
      request: { release: "pkg-1" },
      approvalRequired: false,
      execute: async () => {
        counters.remote += 1;
        throw new AmbiguousEffectError("connection lost after send");
      },
      reconcile: async () => {
        counters.reconciled += 1;
        return { found: true, remoteRef: "pub-1", result: { value: 1 } };
      },
    };

    const first = await runtime.runTaskEffect(task.id, spec);
    assert.equal(first.decision, "executed");
    const record = await journal.getByKey(`task/${task.id}/publish`);
    assert.equal(record?.status, "UNKNOWN");
    assert.equal(counters.remote, 1);

    // Without a reconcile spec the resume gate parks on RECONCILIATION.
    const parked = await runtime.resume(task.id, { effects: [] });
    assert.equal(parked.outcome, "blocked");
    if (parked.outcome === "blocked") assert.equal(parked.reason, "effect-unsettled");
    assert.equal(counters.remote, 1, "UNKNOWN must not be retried");

    // With a reconcile the gate confirms remotely without re-executing.
    const reconciled = await runtime.resume(task.id, { effects: [spec] });
    assert.equal(reconciled.outcome, "resumed");
    assert.equal(counters.remote, 1, "reconciliation is read-only");
    assert.equal(counters.reconciled, 1);
    const settled = await journal.getByKey(`task/${task.id}/publish`);
    assert.equal(settled?.status, "CONFIRMED");
  });

  it("derived snapshot: goal/status/waitingFor/confirmed/unknowns/artifacts/unresolvedEffects", async () => {
    const { runtime, journal } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "ship pkg", adapter: "pi" });
    await runtime.linkArtifact(task.id, "artifact://sha256/deadbeef", "evidence");
    await runtime.runTaskEffect(task.id, publishSpec(counters, { approvalRequired: true }));

    const snapshot = await runtime.snapshot(task.id);
    assert.equal(snapshot.goal, "ship pkg");
    assert.equal(snapshot.status, "WAITING");
    assert.equal(snapshot.waitingFor.length, 1);
    assert.equal(snapshot.waitingFor[0]?.kind, "APPROVAL");
    assert.equal(snapshot.artifacts[0]?.artifactId, "artifact://sha256/deadbeef");

    await runtime.approve(task.id);
    const before = (await journal.list()).length;
    void before;
    const resumed = await runtime.resume(task.id, {
      effects: [publishSpec(counters, { approvalRequired: true })],
      continuation: async (ctx) => {
        await ctx.runtime.runTaskEffect(ctx.task.id, publishSpec(counters, { approvalRequired: true }));
        await ctx.runtime.complete(ctx.task.id);
      },
    });
    assert.equal(resumed.outcome, "resumed");
    const after = await runtime.snapshot(task.id);
    assert.equal(after.status, "COMPLETED");
    assert.deepEqual(after.confirmed, ["publish"]);
    assert.deepEqual(after.unresolvedEffects, []);
    assert.deepEqual(after.waitingFor, []);
  });

  it("cancel is terminal; complete refuses pending awaits", async () => {
    const { runtime } = rig();
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.createAwait(task.id, { kind: "USER", reason: "need input" });
    await assert.rejects(() => runtime.complete(task.id), /still pending/);
    assert.equal(await runtime.cancel(task.id), true);
    const outcome = await runtime.resume(task.id, {});
    assert.equal(outcome.outcome, "cancelled");
  });

  it("runTaskEffect on a non-ACTIVE task is refused", async () => {
    const { runtime } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.createAwait(task.id, { kind: "USER", reason: "hold" });
    await assert.rejects(
      () => runtime.runTaskEffect(task.id, publishSpec(counters)),
      /not.*ACTIVE|WAITING/i,
    );
    assert.equal(counters.remote, 0);
  });

  it("runTaskEffect refuses while a foreign wait is pending (split ACTIVE+pending state)", async () => {
    const { runtime, store } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    // Legacy split state: an await row committed while the task row stayed
    // ACTIVE. Effect execution must respect the pending wait regardless.
    await store.insertAwait({
      id: "w-split",
      taskId: task.id,
      kind: "USER",
      status: "PENDING",
      reason: "parked by an older runtime",
      ref: undefined,
      binding: undefined,
      createdAt: 1,
      resolvedAt: undefined,
    });
    await assert.rejects(
      () => runtime.runTaskEffect(task.id, publishSpec(counters)),
      /pending wait|await/i,
    );
    assert.equal(counters.remote, 0);
  });

  it("task events are committed facts, in order", async () => {
    const { runtime } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.attachAgent(task.id, { sessionId: "sess-1" });
    await runtime.runTaskEffect(task.id, publishSpec(counters, { approvalRequired: true }));
    await runtime.approve(task.id);
    await runtime.resume(task.id, {
      effects: [publishSpec(counters, { approvalRequired: true })],
      continuation: async (ctx) => {
        await ctx.runtime.runTaskEffect(ctx.task.id, publishSpec(counters, { approvalRequired: true }));
        await ctx.runtime.complete(ctx.task.id);
      },
    });
    const events = await runtime.taskEvents(task.id);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "TASK_CREATED",
        "AGENT_ATTACHED",
        "WAIT_CREATED",
        "WAIT_RESOLVED",
        "TASK_RESUMED",
        "EFFECT_PREPARED",
        "EFFECT_CONFIRMED",
        "TASK_COMPLETED",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 1 (RELAYMUSE_HARDENING_PLAN): recovery, approval binding, completion
// gate. These tests are written against the REQUIRED behavior and fail on the
// un-hardened runtime.
// ---------------------------------------------------------------------------

/** AgentResumeResult plus the explicit stage-1 status classification. */
type RichAgentResult = AgentResumeResult & {
  status?: "completed" | "pending" | "idle" | "failed";
};

function scriptAdapter(calls: { resume: number }, results: RichAgentResult[]): AgentAdapter {
  return {
    id: "pi",
    resume: async () => {
      const result = results[Math.min(calls.resume, results.length - 1)] ?? { resumed: true };
      calls.resume += 1;
      return result;
    },
  };
}

describe("adapter resume semantics (stage 1)", () => {
  it("pending agent result parks durably: no continuation, no mutation, resumable after it", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    const counters = { remote: 0 };
    let continuationCalls = 0;
    const adapter = scriptAdapter(adapterCalls, [
      { resumed: false, status: "pending", detail: "deferred run still pending after 40 polls" },
      { resumed: true, status: "completed", output: "job output" },
    ]);
    const continuation = async (ctx: { task: { id: string }; runtime: TaskRuntime }) => {
      continuationCalls += 1;
      await ctx.runtime.runTaskEffect(ctx.task.id, publishSpec(counters));
    };

    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.attachAgent(task.id, { sessionFile: "/tmp/sess.jsonl", deferredRef: { provider: "p", modelId: "m", api: "a", id: "job-1" } });

    const first = await runtime.resume(task.id, { adapter, continuation });
    assert.equal(first.outcome, "waiting", "pending adapter must not report resumed");
    assert.equal(continuationCalls, 0, "continuation must not run while the agent leg is pending");
    assert.equal(counters.remote, 0);
    assert.equal((await runtime.getTask(task.id))?.status, "WAITING");
    const waits = await runtime.pendingAwaits(task.id);
    assert.equal(waits.length, 1, "the adapter-pending wait must be persisted");
    assert.equal(waits[0]?.kind, "EXTERNAL");
    assert.equal(waits[0]?.ref, "adapter:pi");

    const second = await runtime.resume(task.id, { adapter, continuation });
    assert.equal(second.outcome, "resumed");
    assert.equal(continuationCalls, 1);
    assert.equal(counters.remote, 1);
    assert.equal((await runtime.pendingAwaits(task.id)).length, 0, "the adapter wait clears once the agent leg completes");
  });

  it("idle result (no deferred run) is legitimate: continuation runs", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    let continuationCalls = 0;
    const adapter = scriptAdapter(adapterCalls, [
      { resumed: false, status: "idle", detail: "no deferred run to continue" },
    ]);
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const outcome = await runtime.resume(task.id, {
      adapter,
      continuation: async () => {
        continuationCalls += 1;
      },
    });
    assert.equal(outcome.outcome, "resumed");
    assert.equal(continuationCalls, 1, "idle is not pending — the agent leg has nothing to wait for");
  });

  it("failed result blocks resumably: no continuation, no mutation, later resume recovers", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    let continuationCalls = 0;
    const adapter = scriptAdapter(adapterCalls, [
      { resumed: false, status: "failed", detail: "transport error" },
      { resumed: true, status: "completed" },
    ]);
    const continuation = async () => {
      continuationCalls += 1;
    };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });

    const first = await runtime.resume(task.id, { adapter, continuation });
    assert.equal(first.outcome, "blocked");
    if (first.outcome === "blocked") assert.equal(first.reason, "adapter");
    assert.equal(continuationCalls, 0);
    const status = (await runtime.getTask(task.id))?.status;
    assert.notEqual(status, "COMPLETED");
    assert.notEqual(status, "CANCELLED");

    const second = await runtime.resume(task.id, { adapter, continuation });
    assert.equal(second.outcome, "resumed", "an adapter failure parks; it does not end the task");
    assert.equal(continuationCalls, 1);
  });

  it("a legacy {resumed:false} result (no status) maps to pending, not failure", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    let continuationCalls = 0;
    const adapter = scriptAdapter(adapterCalls, [{ resumed: false, detail: "still pending" }]);
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const outcome = await runtime.resume(task.id, {
      adapter,
      continuation: async () => {
        continuationCalls += 1;
      },
    });
    assert.equal(outcome.outcome, "waiting", "unqualified false must not be treated as done or as failure");
    assert.equal(continuationCalls, 0);
  });

  it("adapter.resume is never invoked while a human await is pending", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.createAwait(task.id, { kind: "USER", reason: "need input" });
    const outcome = await runtime.resume(task.id, { adapter: scriptAdapter(adapterCalls, [{ resumed: true }]) });
    assert.equal(outcome.outcome, "blocked");
    assert.equal(adapterCalls.resume, 0, "human gate precedes the adapter gate");
  });

  it("an unrelated application EXTERNAL await stays pending and blocks the adapter gate", async () => {
    const { runtime, store } = rig();
    const adapterCalls = { resume: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const ext = await runtime.createAwait(task.id, {
      kind: "EXTERNAL",
      reason: "waiting on a webhook",
      ref: "app:webhook-42",
    });
    const outcome = await runtime.resume(task.id, { adapter: scriptAdapter(adapterCalls, [{ resumed: true }]) });
    assert.equal(outcome.outcome, "blocked");
    assert.equal(adapterCalls.resume, 0);
    const after = await store.getAwait(ext.id);
    assert.equal(after?.status, "PENDING", "only the adapter-owned wait may auto-resolve");
  });

  it("a pending human approval is never bypassed by an adapter-pending wait", async () => {
    const { runtime } = rig();
    const adapterCalls = { resume: 0 };
    let continuationCalls = 0;
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    // First resume: adapter reports pending -> adapter-owned EXTERNAL wait.
    const adapter = scriptAdapter(adapterCalls, [
      { resumed: false, status: "pending" },
      { resumed: true, status: "completed" },
    ]);
    const first = await runtime.resume(task.id, { adapter });
    assert.equal(first.outcome, "waiting");
    assert.equal(adapterCalls.resume, 1);

    // A human approval wait lands while the adapter wait is still pending.
    await runtime.createAwait(task.id, {
      kind: "APPROVAL",
      reason: "late approval gate",
      ref: "publish",
    });
    const second = await runtime.resume(task.id, {
      adapter,
      continuation: async () => {
        continuationCalls += 1;
      },
    });
    assert.equal(second.outcome, "blocked");
    if (second.outcome === "blocked") assert.equal(second.reason, "await-pending");
    assert.equal(adapterCalls.resume, 1, "adapter.resume must not run while a human await is pending");
    assert.equal(continuationCalls, 0);
  });
});

function approvalSpec(counters: { remote: number }, request: unknown, kind = "http/publish"): TaskEffectSpec {
  return {
    name: "publish",
    kind,
    request,
    approvalRequired: true,
    execute: async () => {
      counters.remote += 1;
      return { remoteRef: "pub-1" };
    },
  };
}

describe("approval binding (stage 1)", () => {
  it("an approval for request A does not authorize request B under the same name", async () => {
    const { runtime } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });

    const specA = approvalSpec(counters, { release: "pkg-A" });
    const specB = approvalSpec(counters, { release: "pkg-B" });

    const first = await runtime.runTaskEffect(task.id, specA);
    assert.equal(first.decision, "awaiting-approval");
    await runtime.approve(task.id);

    // Restart/recover: the gate clears and the app re-runs the same-named
    // effect with a DRIFTED request inside its continuation.
    const drifted = await runtime.resume(task.id, {
      continuation: async (ctx) => {
        const outcome = await ctx.runtime.runTaskEffect(ctx.task.id, specB);
        assert.equal(outcome.decision, "awaiting-approval", "drifted request must be re-approved");
      },
    });
    assert.equal(drifted.outcome, "resumed");
    assert.equal(counters.remote, 0);
    assert.equal((await runtime.getTask(task.id))?.status, "WAITING");

    // Approving the new bound wait executes B exactly once.
    await runtime.approve(task.id);
    await runtime.resume(task.id, {
      continuation: async (ctx) => {
        const outcome = await ctx.runtime.runTaskEffect(ctx.task.id, specB);
        assert.equal(outcome.decision, "executed");
      },
    });
    assert.equal(counters.remote, 1);
  });

  it("an approval for kind A does not authorize kind B with the same request", async () => {
    const { runtime } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.runTaskEffect(task.id, approvalSpec(counters, { release: "pkg-A" }, "http/publish"));
    await runtime.approve(task.id);
    await runtime.resume(task.id, {
      continuation: async (ctx) => {
        const outcome = await ctx.runtime.runTaskEffect(
          ctx.task.id,
          approvalSpec(counters, { release: "pkg-A" }, "fs/delete"),
        );
        assert.equal(outcome.decision, "awaiting-approval", "drifted kind must be re-approved");
      },
    });
    assert.equal(counters.remote, 0);
  });

  it("a legacy resolved approval without a binding fails closed", async () => {
    const { runtime, store } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    // Simulates a pre-stage-1 DB: a resolved APPROVAL await carries no binding.
    await store.insertAwait({
      id: "legacy-approval",
      taskId: task.id,
      kind: "APPROVAL",
      status: "RESOLVED",
      reason: "approved before bindings existed",
      ref: "publish",
      binding: undefined,
      createdAt: 1,
      resolvedAt: 2,
    });
    const outcome = await runtime.runTaskEffect(task.id, approvalSpec(counters, { release: "pkg-A" }));
    assert.equal(outcome.decision, "awaiting-approval", "an unbound legacy approval must not authorize new requests");
    assert.equal(counters.remote, 0);
  });

  it("the approved binding is inspectable on the snapshot's waitingFor entry", async () => {
    const { runtime } = rig();
    const counters = { remote: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    await runtime.runTaskEffect(task.id, approvalSpec(counters, { release: "pkg-A" }));
    const snapshot = await runtime.snapshot(task.id);
    const wait = snapshot.waitingFor[0] as { kind?: string; binding?: { kind: string; requestHash: string } } | undefined;
    assert.equal(wait?.kind, "APPROVAL");
    assert.equal(wait?.binding?.kind, "http/publish");
    assert.equal(wait?.binding?.requestHash, hashRequest({ release: "pkg-A" }));
  });
});

describe("completion gate (stage 1)", () => {
  function ambiguousSpec(counters: { remote: number; reconciled: number }): TaskEffectSpec {
    return {
      name: "publish",
      kind: "http/publish",
      request: { release: "pkg-1" },
      approvalRequired: false,
      execute: async () => {
        counters.remote += 1;
        throw new AmbiguousEffectError("lost the response");
      },
      reconcile: async () => {
        counters.reconciled += 1;
        return { found: true, remoteRef: "pub-1", result: { ok: true } };
      },
    };
  }

  it("complete refuses while an UNKNOWN effect is unsettled; resume still reconciles", async () => {
    const { runtime, journal } = rig();
    const counters = { remote: 0, reconciled: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const outcome = await runtime.runTaskEffect(task.id, ambiguousSpec(counters));
    assert.equal(outcome.decision, "executed");
    if (outcome.decision === "executed") assert.equal(outcome.outcome.status, "unknown");

    await assert.rejects(() => runtime.complete(task.id), /unsettled|pending/i);
    assert.notEqual((await runtime.getTask(task.id))?.status, "COMPLETED");

    const resumed = await runtime.resume(task.id, { effects: [ambiguousSpec(counters)] });
    assert.equal(resumed.outcome, "resumed", "the task must stay recoverable, not be completed");
    assert.equal(counters.remote, 1, "reconcile never re-executes");
    assert.equal((await journal.getByKey(`task/${task.id}/publish`))?.status, "CONFIRMED");
    assert.equal(await runtime.complete(task.id), true);
  });

  it("complete refuses a PREPARED effect (crash before submit)", async () => {
    const { runtime, journal } = rig();
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const at = 1_000;
    await journal.insertPrepared({
      id: "eff-prepared",
      key: `task/${task.id}/publish`,
      kind: "http/publish",
      requestHash: hashRequest({ release: "pkg-1" }),
      replay: "never",
      status: "PREPARED",
      remoteRef: undefined,
      resultJson: undefined,
      reason: undefined,
      createdAt: at,
      submittedAt: undefined,
      settledAt: undefined,
      updatedAt: at,
    });
    await assert.rejects(() => runtime.complete(task.id), /unsettled|pending/i);
  });

  it("a FAILED (settled) effect does not block completion — the app decides", async () => {
    const { runtime } = rig();
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const failing: TaskEffectSpec = {
      name: "publish",
      kind: "http/publish",
      request: { release: "pkg-1" },
      approvalRequired: false,
      execute: async () => {
        throw new Error("remote rejected");
      },
    };
    const outcome = await runtime.runTaskEffect(task.id, failing);
    if (outcome.decision === "executed") assert.equal(outcome.outcome.status, "failed");
    assert.equal(await runtime.complete(task.id), true, "FAILED is definitive; refusal lives in the app layer");
  });

  it("reconciliation is not re-gated on approval (read-only settle)", async () => {
    const { runtime, journal } = rig();
    const counters = { remote: 0, reconciled: 0 };
    const task = await runtime.createTask({ goal: "release", adapter: "pi" });
    const spec: TaskEffectSpec = {
      name: "publish",
      kind: "http/publish",
      request: { release: "pkg-1" },
      approvalRequired: true,
      execute: async () => {
        counters.remote += 1;
        throw new AmbiguousEffectError("crash after remote commit");
      },
      reconcile: async () => {
        counters.reconciled += 1;
        return { found: true, remoteRef: "pub-1", result: { ok: true } };
      },
    };
    await runtime.runTaskEffect(task.id, spec);
    await runtime.approve(task.id);
    // Approved resume runs the effect; it goes ambiguous -> UNKNOWN.
    await runtime.resume(task.id, {
      effects: [spec],
      continuation: async (ctx) => {
        const outcome = await ctx.runtime.runTaskEffect(ctx.task.id, spec);
        assert.equal(outcome.decision, "executed");
        if (outcome.decision === "executed") assert.equal(outcome.outcome.status, "unknown");
      },
    });
    assert.equal(counters.remote, 1);

    // A fresh approval wait lands before reconciliation — the read-only
    // reconcile in the resume gate must still run.
    await runtime.createAwait(task.id, { kind: "APPROVAL", reason: "unrelated gate", ref: "other" });
    const resumed = await runtime.resume(task.id, { effects: [spec] });
    assert.equal(resumed.outcome, "blocked", "the unrelated approval still gates continuation");
    assert.equal(counters.reconciled, 1, "reconcile ran before the await gate");
    assert.equal((await journal.getByKey(`task/${task.id}/publish`))?.status, "CONFIRMED");
  });
});

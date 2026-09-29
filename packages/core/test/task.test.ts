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
  type AgentAdapter,
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

/**
 * SqliteTaskStore acceptance: durable task + await rows survive process
 * close/reopen (AC-01, AC-02), guarded transitions refuse invalid moves,
 * await resolution is a one-shot no-op-on-repeat, and task↔effect/artifact
 * links + task events persist atomically.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import type { AwaitPoint, DurableTask } from "@relay/core";
import { SqliteTaskStore } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-task-store-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let dbCounter = 0;
function dbPath(): string {
  dbCounter += 1;
  return join(tmp, `tasks-${dbCounter}.db`);
}

function taskFixture(id: string, goal = "release the package"): DurableTask {
  return {
    id,
    goal,
    status: "ACTIVE",
    adapter: "pi",
    agentRef: undefined,
    investigationId: undefined,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describe("SqliteTaskStore", () => {
  it("AC-01: task identity survives close/reopen", async () => {
    const path = dbPath();
    const first = await SqliteTaskStore.open({ path });
    await first.insertTask(taskFixture("t-1"), [{ type: "TASK_CREATED", at: 1_000 }]);
    first.close();

    const second = await SqliteTaskStore.open({ path });
    const task = await second.getTask("t-1");
    assert.ok(task !== undefined);
    assert.equal(task.id, "t-1");
    assert.equal(task.goal, "release the package");
    assert.equal(task.status, "ACTIVE");
    assert.equal(task.adapter, "pi");
    const events = await second.taskEvents("t-1");
    assert.deepEqual(events.map((e) => e.type), ["TASK_CREATED"]);
    second.close();
  });

  it("AC-02: WAITING task + pending await survive close/reopen", async () => {
    const path = dbPath();
    const first = await SqliteTaskStore.open({ path });
    await first.insertTask(taskFixture("t-2"), [{ type: "TASK_CREATED", at: 1_000 }]);
    const await_: AwaitPoint = {
      id: "a-1",
      taskId: "t-2",
      kind: "APPROVAL",
      status: "PENDING",
      reason: "publish requires human approval",
      ref: "publish",
      binding: undefined,
      createdAt: 1_100,
      resolvedAt: undefined,
    };
    await first.insertAwait(await_, [{ type: "WAIT_CREATED", ref: "a-1", at: 1_100 }]);
    const moved = await first.transitionTask("t-2", ["ACTIVE"], "WAITING", 1_100);
    assert.equal(moved?.status, "WAITING");
    first.close();

    const second = await SqliteTaskStore.open({ path });
    const task = await second.getTask("t-2");
    assert.equal(task?.status, "WAITING");
    const pending = await second.pendingAwaits("t-2");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.kind, "APPROVAL");
    assert.equal(pending[0]?.ref, "publish");
    const resolved = await second.resolveAwait("a-1", 1_200, [
      { type: "WAIT_RESOLVED", ref: "a-1", at: 1_200 },
    ]);
    assert.equal(resolved, "resolved");
    // Rule 4: a second resolve is a provable no-op.
    const again = await second.resolveAwait("a-1", 1_300, [
      { type: "WAIT_RESOLVED", ref: "a-1", at: 1_300 },
    ]);
    assert.equal(again, "already-resolved");
    const events = await second.taskEvents("t-2");
    assert.deepEqual(
      events.map((e) => e.type),
      ["TASK_CREATED", "WAIT_CREATED", "WAIT_RESOLVED"],
    );
    second.close();
  });

  it("guarded transitions reject terminal/invalid states atomically (no row change, no event)", async () => {
    const path = dbPath();
    const store = await SqliteTaskStore.open({ path });
    await store.insertTask(taskFixture("t-3"), [{ type: "TASK_CREATED", at: 1_000 }]);
    const rejected = await store.transitionTask("t-3", ["WAITING"], "BLOCKED", 1_100, [
      { type: "TASK_BLOCKED", at: 1_100 },
    ]);
    assert.equal(rejected, undefined);
    const task = await store.getTask("t-3");
    assert.equal(task?.status, "ACTIVE");
    assert.deepEqual(
      (await store.taskEvents("t-3")).map((e) => e.type),
      ["TASK_CREATED"],
    );
    const completed = await store.transitionTask("t-3", ["ACTIVE"], "COMPLETED", 1_200, [
      { type: "TASK_COMPLETED", at: 1_200 },
    ]);
    assert.equal(completed?.status, "COMPLETED");
    const after = await store.transitionTask("t-3", ["ACTIVE"], "ACTIVE", 1_300, [
      { type: "TASK_RESUMED", at: 1_300 },
    ]);
    assert.equal(after, undefined, "COMPLETED must be terminal");
    store.close();
  });

  it("effect/artifact links + agentRef patch persist across reopen", async () => {
    const path = dbPath();
    const first = await SqliteTaskStore.open({ path });
    await first.insertTask(taskFixture("t-4"), [{ type: "TASK_CREATED", at: 1_000 }]);
    await first.updateTask(
      "t-4",
      { agentRef: { sessionId: "pi-session-1", deferredRef: { provider: "p", modelId: "m", api: "a", id: "job-1" } } },
      1_100,
      [{ type: "AGENT_ATTACHED", ref: "pi-session-1", at: 1_100 }],
    );
    await first.linkEffect({ taskId: "t-4", effectId: "eff-1", key: "task/t-4/publish", kind: "http/publish", at: 1_200 }, [
      { type: "EFFECT_PREPARED", ref: "task/t-4/publish", at: 1_200 },
    ]);
    await first.linkArtifact({ taskId: "t-4", artifactId: "artifact://sha256/abc", role: "evidence", at: 1_300 }, [
      { type: "ARTIFACT_CREATED", ref: "artifact://sha256/abc", at: 1_300 },
    ]);
    first.close();

    const second = await SqliteTaskStore.open({ path });
    const task = await second.getTask("t-4");
    assert.equal(task?.agentRef?.sessionId, "pi-session-1");
    assert.equal(task?.agentRef?.deferredRef?.id, "job-1");
    const effects = await second.taskEffects("t-4");
    assert.deepEqual(
      effects.map((e) => e.key),
      ["task/t-4/publish"],
    );
    const artifacts = await second.taskArtifacts("t-4");
    assert.equal(artifacts[0]?.artifactId, "artifact://sha256/abc");
    assert.equal(artifacts[0]?.role, "evidence");
    assert.deepEqual(
      (await second.taskEvents("t-4")).map((e) => e.type),
      ["TASK_CREATED", "AGENT_ATTACHED", "EFFECT_PREPARED", "ARTIFACT_CREATED"],
    );
    second.close();
  });

  it("shares one database file with the effect journal tables", async () => {
    const path = dbPath();
    const { SqliteEffectJournal } = await import("../src/journal.js");
    const journal = await SqliteEffectJournal.open({ path });
    const tasks = await SqliteTaskStore.open({ path });
    await tasks.insertTask(taskFixture("t-5"), [{ type: "TASK_CREATED", at: 1_000 }]);
    journal.close();
    tasks.close();
    const reopened = await SqliteTaskStore.open({ path });
    assert.equal((await reopened.getTask("t-5"))?.goal, "release the package");
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Stage 1: atomic parking (await row + events + WAITING in one commit) and
// await bindings persisted for inspection.
// ---------------------------------------------------------------------------

interface ParkCapable {
  parkAwait(
    taskId: string,
    await_: AwaitPoint,
    at: number,
    events?: readonly { type: string; ref?: string | undefined; at: number }[],
  ): Promise<DurableTask | undefined>;
}

function awaitFixture(id: string, taskId: string, overrides: Partial<AwaitPoint> = {}): AwaitPoint {
  return {
    id,
    taskId,
    kind: "APPROVAL",
    status: "PENDING",
    reason: "publish requires human approval",
    ref: "publish",
    binding: undefined,
    createdAt: 1_100,
    resolvedAt: undefined,
    ...overrides,
  };
}

describe("SqliteTaskStore atomic parking (stage 1)", () => {
  it("parkAwait commits await row + WAIT_CREATED + WAITING in one step, reopen-consistent", async () => {
    const path = dbPath();
    const first = await SqliteTaskStore.open({ path });
    await first.insertTask(taskFixture("t-park"), [{ type: "TASK_CREATED", at: 1_000 }]);
    const parked = await (first as unknown as ParkCapable).parkAwait(
      "t-park",
      awaitFixture("a-park", "t-park"),
      1_100,
      [{ type: "WAIT_CREATED", ref: "a-park", at: 1_100 }],
    );
    assert.equal(parked?.status, "WAITING");
    first.close();

    const second = await SqliteTaskStore.open({ path });
    const task = await second.getTask("t-park");
    assert.equal(task?.status, "WAITING");
    const pending = await second.pendingAwaits("t-park");
    assert.equal(pending.length, 1, "the await row and the WAITING status commit together");
    assert.equal(pending[0]?.id, "a-park");
    assert.deepEqual(
      (await second.taskEvents("t-park")).map((e) => e.type),
      ["TASK_CREATED", "WAIT_CREATED"],
    );
    second.close();
  });

  it("parkAwait refuses terminal tasks and commits nothing (no row, no event, no status change)", async () => {
    const path = dbPath();
    const store = await SqliteTaskStore.open({ path });
    await store.insertTask(taskFixture("t-term"), [{ type: "TASK_CREATED", at: 1_000 }]);
    await store.transitionTask("t-term", ["ACTIVE"], "COMPLETED", 1_050, [
      { type: "TASK_COMPLETED", at: 1_050 },
    ]);
    const parked = await (store as unknown as ParkCapable).parkAwait(
      "t-term",
      awaitFixture("a-term", "t-term"),
      1_100,
      [{ type: "WAIT_CREATED", ref: "a-term", at: 1_100 }],
    );
    assert.equal(parked, undefined, "terminal tasks cannot be parked");
    assert.equal((await store.getTask("t-term"))?.status, "COMPLETED");
    assert.equal((await store.pendingAwaits("t-term")).length, 0);
    assert.deepEqual(
      (await store.taskEvents("t-term")).map((e) => e.type),
      ["TASK_CREATED", "TASK_COMPLETED"],
    );
    store.close();
  });

  it("parkAwait rolls back the whole park when the event commit fails", async () => {
    const path = dbPath();
    const store = await SqliteTaskStore.open({ path });
    await store.insertTask(taskFixture("t-rb"), [{ type: "TASK_CREATED", at: 1_000 }]);
    await assert.rejects(
      (store as unknown as ParkCapable).parkAwait("t-rb", awaitFixture("a-rb", "t-rb"), 1_100, [
        { type: "NOT_A_REAL_EVENT", ref: "a-rb", at: 1_100 },
      ]),
    );
    // Nothing may leak through: no await row, task still ACTIVE, no event.
    assert.equal((await store.getTask("t-rb"))?.status, "ACTIVE");
    assert.equal((await store.pendingAwaits("t-rb")).length, 0);
    assert.deepEqual(
      (await store.taskEvents("t-rb")).map((e) => e.type),
      ["TASK_CREATED"],
    );
    store.close();
  });

  it("await binding (kind + requestHash) persists across close/reopen", async () => {
    const path = dbPath();
    const binding = { kind: "http/publish", requestHash: "deadbeef" };
    const first = await SqliteTaskStore.open({ path });
    await first.insertTask(taskFixture("t-bind"), [{ type: "TASK_CREATED", at: 1_000 }]);
    await (first as unknown as ParkCapable).parkAwait(
      "t-bind",
      awaitFixture("a-bind", "t-bind", { binding } as unknown as Partial<AwaitPoint>),
      1_100,
      [{ type: "WAIT_CREATED", ref: "a-bind", at: 1_100 }],
    );
    first.close();

    const second = await SqliteTaskStore.open({ path });
    const pending = await second.pendingAwaits("t-bind");
    const bound = pending[0] as (AwaitPoint & { binding?: { kind: string; requestHash: string } }) | undefined;
    assert.deepEqual(bound?.binding, binding);
    second.close();
  });

  it("a legacy awaits table without binding_json is migrated and reads as unbound", async () => {
    const path = dbPath();
    // Build a pre-stage-1 awaits table by hand: no binding_json column.
    const sqlite = await import("node:sqlite");
    await mkdir(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    db.exec(`CREATE TABLE relay_task_awaits (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT NOT NULL, ref TEXT,
      created_at INTEGER NOT NULL, resolved_at INTEGER
    )`);
    db.prepare(
      "INSERT INTO relay_task_awaits (id, task_id, kind, status, reason, ref, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("a-legacy", "t-legacy", "APPROVAL", "RESOLVED", "approved before bindings", "publish", 1, 2);
    db.close();

    const store = await SqliteTaskStore.open({ path });
    const awaits = await store.awaits("t-legacy");
    assert.equal(awaits.length, 1);
    assert.equal(
      (awaits[0] as AwaitPoint & { binding?: unknown }).binding,
      undefined,
      "legacy rows read as unbound and must fail closed",
    );
    store.close();
  });
});

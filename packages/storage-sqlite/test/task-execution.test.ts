/** Task admission/terminal races across real processes on one SQLite file. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { TaskRuntime, type TaskEffectSpec } from "@relay/core";
import { SqliteEffectJournal, SqliteTaskStore } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-task-execution-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let sequence = 0;

function child(path: string, taskId: string, mode: string) {
  const proc = spawn(process.execPath, [
    fileURLToPath(new URL("./fixtures/task-execution-child.js", import.meta.url)), path, taskId, mode,
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: { type: string; result?: unknown; message?: string }[] = [];
  const waiters = new Set<() => void>();
  let exited = false;
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.on("message", (message: { type: string; result?: unknown; message?: string }) => {
    messages.push(message);
    for (const wake of waiters) wake();
  });
  const closed = new Promise<void>((resolve) => {
    proc.on("close", () => { exited = true; for (const wake of waiters) wake(); resolve(); });
  });
  const wait = async (type: string) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`child timed out: ${type}; ${stderr}`)); }, 30_000);
      const check = () => {
        const error = messages.find((m) => m.type === "error");
        if (messages.some((m) => m.type === type)) {
          clearTimeout(timer); waiters.delete(check); resolve();
        } else if (error !== undefined || exited) {
          clearTimeout(timer); waiters.delete(check); reject(new Error(error?.message ?? `child exited: ${stderr}`));
        }
      };
      waiters.add(check);
      check();
    });
    return messages.find((m) => m.type === type)!;
  };
  return { proc, messages, wait, closed, async stop() {
    if (!exited) proc.kill("SIGKILL");
    await closed;
  } };
}

async function rig() {
  const path = join(tmp, `${++sequence}.db`);
  const store = await SqliteTaskStore.open({ path });
  const journal = await SqliteEffectJournal.open({ path });
  const runtime = new TaskRuntime({ store, journal });
  const task = await runtime.createTask({ goal: "ship", adapter: "pi" });
  return { path, store, journal, runtime, task, close() { journal.close(); store.close(); } };
}

function spec(): TaskEffectSpec {
  return {
    name: "publish", kind: "test/publish", request: { release: 1 }, approvalRequired: false,
    execute: async () => { throw new Error("unexpected execution"); },
  };
}

describe("TaskRuntime execution lease (cross-process)", () => {
  it("completion holds admission closed even after reading an empty journal", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "complete");
    try {
      await c.wait("checking");
      await assert.rejects(r.runtime.runTaskEffect(r.task.id, spec()), { name: "TaskExecutionBusyError" });
      c.proc.send("release");
      assert.equal((await c.wait("done")).result, true);
      await c.closed;
      assert.equal((await r.store.getTask(r.task.id))?.status, "COMPLETED");
      assert.equal((await r.journal.list()).length, 0);
    } finally { await c.stop(); r.close(); }
  });

  it("admission excludes completion before PREPARED; cancellation blocks later admissions", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "admission");
    try {
      await c.wait("admitted");
      assert.equal((await r.journal.list()).length, 0);
      await assert.rejects(r.runtime.complete(r.task.id), { name: "TaskExecutionBusyError" });
      assert.equal(await r.runtime.cancel(r.task.id), true);
      await assert.rejects(r.runtime.runTaskEffect(r.task.id, spec()), { name: "TaskNotActiveError" });
      c.proc.send("release");
      await c.wait("done");
      await c.closed;
      assert.equal((await r.store.getTask(r.task.id))?.status, "CANCELLED");
      assert.equal((await r.journal.list())[0]?.status, "CONFIRMED", "already admitted work retains its result");
    } finally { await c.stop(); r.close(); }
  });

  it("an await parked by another process wins over a stale completion check", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "complete");
    try {
      await c.wait("checking");
      await r.runtime.createAwait(r.task.id, { kind: "USER", reason: "need input" });
      c.proc.send("release");
      assert.equal((await c.wait("done")).result, false);
      await c.closed;
      assert.equal((await r.store.getTask(r.task.id))?.status, "WAITING");
      assert.equal((await r.store.pendingAwaits(r.task.id)).length, 1);
    } finally { await c.stop(); r.close(); }
  });

  it("a live effect excludes a second execution and completion, then releases its lease", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "effect");
    try {
      await c.wait("executing");
      await assert.rejects(r.runtime.runTaskEffect(r.task.id, spec()), { name: "TaskExecutionBusyError" });
      await assert.rejects(r.runtime.complete(r.task.id), { name: "TaskExecutionBusyError" });
      c.proc.send("release");
      await c.wait("done");
      await c.closed;
      assert.equal(await r.runtime.complete(r.task.id), true);
      assert.equal((await r.journal.list())[0]?.status, "CONFIRMED");
      assert.equal(c.messages.filter((m) => m.type === "executing").length, 1);
    } finally { await c.stop(); r.close(); }
  });

  it("cancel during adapter await prevents continuation in the resume process", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "resume");
    try {
      await c.wait("adapter");
      assert.equal(await r.runtime.cancel(r.task.id), true);
      c.proc.send("release");
      assert.equal(((await c.wait("done")).result as { outcome: string }).outcome, "cancelled");
      await c.closed;
      assert.equal(c.messages.filter((m) => m.type === "continued").length, 0);
      assert.equal((await r.store.getTask(r.task.id))?.status, "CANCELLED");
      assert.equal((await r.store.taskEvents(r.task.id)).filter((e) => e.type === "TASK_RESUMED").length, 0);
    } finally { await c.stop(); r.close(); }
  });

  it("SIGKILL leaves a recoverable lease and SUBMITTED stays gated until read-only reconciliation", async () => {
    const r = await rig();
    const c = child(r.path, r.task.id, "effect");
    try {
      await c.wait("executing");
      c.proc.kill("SIGKILL");
      await c.closed;
      await assert.rejects(r.runtime.complete(r.task.id), { name: "TaskUnsettledEffectsError" });
      assert.equal((await r.journal.list())[0]?.status, "SUBMITTED");
      let executed = 0;
      const recovery = { ...spec(), execute: async () => { executed += 1; },
        reconcile: async () => ({ found: true as const, remoteRef: "pub-1", result: { accepted: true } }) };
      const result = await r.runtime.resume(r.task.id, {
        effects: [recovery],
        continuation: async ({ runtime, task }) => {
          await runtime.runTaskEffect(task.id, recovery);
          await runtime.complete(task.id);
        },
      });
      assert.equal(result.outcome, "resumed");
      assert.equal(executed, 0);
      assert.equal((await r.journal.list())[0]?.status, "CONFIRMED");
      assert.equal((await r.store.getTask(r.task.id))?.status, "COMPLETED");
    } finally { await c.stop(); r.close(); }
  });
});

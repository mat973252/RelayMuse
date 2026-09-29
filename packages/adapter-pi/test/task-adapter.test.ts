/**
 * PiTaskAdapter acceptance: a real Pi AgentSession created through public
 * APIs persists the deferred job reference; a NEW adapter instance (the
 * "restarted process") recovers it and continues through fetchDeferred —
 * the provider's submission count stays 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MemoryTaskStore, TaskRuntime } from "@relay/core";
import {
  PiTaskAdapter,
  createMockDeferredProvider,
  mockDeferredModel,
} from "../src/index.js";
import { startJobServer } from "./fixtures/job-server.js";

const tmp = mkdtempSync(join(tmpdir(), "relay-pi-task-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

class NopJournal {
  async insertPrepared(): Promise<void> {}
  async markSubmitted(): Promise<void> {}
  async markConfirmed(): Promise<void> {}
  async markFailed(): Promise<void> {}
  async markUnknown(): Promise<void> {}
  async get(): Promise<undefined> {
    return undefined;
  }
  async getByKey(): Promise<undefined> {
    return undefined;
  }
  async list(): Promise<never[]> {
    return [];
  }
}

describe("PiTaskAdapter", () => {
  it("attach persists agentRef; a fresh adapter resumes the deferred run", { timeout: 300_000 }, async () => {
    const server = await startJobServer(400);
    const sessionDir = join(tmp, "sessions");
    try {
      const store = new MemoryTaskStore();
      const runtime = new TaskRuntime({
        store,
        journal: new NopJournal() as never,
      });
      const task = await runtime.createTask({ goal: "submit the long-running job", adapter: "pi" });

      const provider = createMockDeferredProvider({ baseUrl: server.baseUrl });
      const adapter = new PiTaskAdapter({
        model: mockDeferredModel(),
        provider,
        cwd: tmp,
        sessionDir,
        pollMs: 50,
      });

      const ref = await adapter.attach(task, {});
      assert.ok(ref.sessionFile?.endsWith(".jsonl"), "a real Pi session file must exist");
      assert.ok(ref.deferredRef !== undefined, "the provider defers -> a handle is persisted");
      await runtime.attachAgent(task.id, ref);
      assert.equal((await runtime.getTask(task.id))?.agentRef?.deferredRef?.id, ref.deferredRef?.id);
      await runtime.createAwait(task.id, {
        kind: "USER",
        reason: "waiting for the deferred job",
        ref: ref.deferredRef?.id,
      });
      assert.equal((await runtime.getTask(task.id))?.status, "WAITING");

      // "Restart": a brand-new adapter over the same session dir — nothing in
      // memory survives except the durable AgentRef.
      const restarted = new PiTaskAdapter({
        model: mockDeferredModel(),
        provider,
        cwd: tmp,
        sessionDir,
        pollMs: 50,
      });
      const inspected = await restarted.inspect(ref);
      assert.equal(inspected.status, "waiting-deferred");

      const result = await restarted.resume(ref);
      assert.equal(result.resumed, true);
      assert.equal((result as { status?: string }).status, "completed");
      assert.ok(String(result.output).length > 0);

      // Resume again after the job completed: no second job submission.
      const again = await restarted.resume(ref);
      assert.equal(again.resumed, true);
      assert.equal((again as { status?: string }).status, "completed");

      assert.equal(server.submissions(), 1, "exactly one job submission across attach+restart+resume");
    } finally {
      await server.stop();
    }
  });
});

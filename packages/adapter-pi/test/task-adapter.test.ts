/**
 * PiTaskAdapter acceptance: a real Pi AgentSession created through public
 * APIs persists the deferred job reference; a NEW adapter instance (the
 * "restarted process") recovers it and continues through fetchDeferred —
 * the provider's submission count stays 1.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { MemoryTaskStore, TaskRuntime } from "@relay/core";
import {
  PiTaskAdapter,
  createMockDeferredProvider,
  mockDeferredModel,
} from "../src/index.js";
import { startJobServer } from "./fixtures/job-server.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

function assistant(stopReason: AssistantMessage["stopReason"] = "stop", text = "synthetic result"): AssistantMessage {
  const model = mockDeferredModel();
  return {
    role: "assistant", content: [{ type: "text", text }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function persistedSession() {
  const manager = SessionManager.create(tmp, join(tmp, "persisted"));
  manager.appendMessage({ role: "user", content: "synthetic instruction", timestamp: Date.now() });
  manager.appendMessage(assistant());
  return { manager, ref: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! } };
}

function offlineAdapter() {
  return new PiTaskAdapter({ model: mockDeferredModel(),
    provider: createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" }),
    cwd: tmp, sessionDir: join(tmp, "persisted") });
}

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
  it("recovers synchronous output from the exact session without provider calls or writes", async () => {
    const { ref } = persistedSession();
    const other = persistedSession();
    other.manager.appendMessage(assistant("stop", "unrelated session"));
    const before = readFileSync(ref.sessionFile);
    const mtime = statSync(ref.sessionFile).mtimeMs;
    for (let i = 0; i < 2; i += 1) {
      const result = await offlineAdapter().resume(ref);
      assert.equal(result.status, "completed");
      assert.equal(result.resumed, false, "persisted output requires no new agent work");
      assert.equal(result.output, "synthetic result");
    }
    assert.deepEqual(readFileSync(ref.sessionFile), before);
    assert.equal(statSync(ref.sessionFile).mtimeMs, mtime);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { PiTaskAdapter, mockDeferredModel, createMockDeferredProvider } from ${JSON.stringify(new URL("../src/index.js", import.meta.url).href)};
      const adapter = new PiTaskAdapter({model: mockDeferredModel(),
        provider: createMockDeferredProvider({baseUrl: "http://127.0.0.1:1"}),
        cwd: ${JSON.stringify(tmp)}, sessionDir: ${JSON.stringify(join(tmp, "persisted"))}});
      console.log(JSON.stringify(await adapter.resume(${JSON.stringify(ref)})));
    `], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).output, "synthetic result");
    assert.deepEqual(readFileSync(ref.sessionFile), before);
    assert.equal(statSync(ref.sessionFile).mtimeMs, mtime);
  });

  it("attaches synchronous Pi sessions using public getters and never repeats the model call on recovery", async () => {
    let modelCalls = 0;
    const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
    const stream = () => {
      modelCalls += 1;
      const events = createAssistantMessageEventStream();
      const message = assistant();
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      return events;
    };
    provider.stream = stream;
    provider.streamSimple = stream;
    const adapter = new PiTaskAdapter({ model: mockDeferredModel(), provider,
      cwd: tmp, sessionDir: join(tmp, "sync-attach") });
    const first = await adapter.attach({ id: "first", goal: "synthetic instruction" });
    const second = await adapter.attach({ id: "second", goal: "synthetic instruction" });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.sessionFile, second.sessionFile);
    assert.equal(first.deferredRef, undefined);
    for (const ref of [first, second]) {
      assert.equal(SessionManager.open(ref.sessionFile!).getSessionId(), ref.sessionId);
      assert.equal((await adapter.resume(ref)).output, "synthetic result");
    }
    assert.equal(modelCalls, 2, "one call per attach; recovery never calls the model");
  });

  for (const reason of ["error", "aborted", "length", "toolUse"] as const) {
    it(`blocks continuation after ${reason}, even with an earlier successful assistant`, async () => {
      const { manager, ref } = persistedSession();
      manager.appendMessage({ role: "user", content: "new instruction", timestamp: Date.now() });
      manager.appendMessage(assistant(reason));
      const runtime = new TaskRuntime({ store: new MemoryTaskStore(), journal: new NopJournal() as never });
      const task = await runtime.createTask({ goal: "synthetic task", adapter: "pi" });
      await runtime.attachAgent(task.id, ref);
      let continued = 0;
      const outcome = await runtime.resume(task.id, { adapter: offlineAdapter(),
        continuation: async () => { continued += 1; } });
      assert.equal(outcome.outcome, "blocked");
      assert.equal(continued, 0);
      assert.equal((await offlineAdapter().inspect(ref)).status, "unknown");
    });
  }

  it("rejects empty output and a newer user prompt instead of reusing old success", async () => {
    for (const empty of [true, false]) {
      const { manager, ref } = persistedSession();
      manager.appendMessage({ role: "user", content: "new instruction", timestamp: Date.now() });
      if (empty) manager.appendMessage(assistant("stop", " \n "));
      assert.equal((await offlineAdapter().resume(ref)).status, "failed");
    }
  });

  it("does not reuse old success when context edits omit the latest prompt and failure", async () => {
    const { manager, ref } = persistedSession();
    const prompt = manager.appendMessage({ role: "user", content: "new instruction", timestamp: Date.now() });
    const failure = manager.appendMessage(assistant("error"));
    manager.appendContextEdit(prompt, null);
    manager.appendContextEdit(failure, null);
    assert.equal((await offlineAdapter().resume(ref)).status, "failed");
  });

  it("rejects missing, empty, truncated and mismatched session references without repairing files", async () => {
    assert.equal((await offlineAdapter().resume({})).status, "failed");
    assert.equal((await offlineAdapter().resume({ sessionFile: join(tmp, "missing.jsonl") })).status, "failed");
    const { ref } = persistedSession();
    assert.equal((await offlineAdapter().resume({ ...ref, sessionId: "wrong-session" })).status, "failed");
    appendFileSync(ref.sessionFile, '{"type":"message"');
    const truncated = readFileSync(ref.sessionFile);
    assert.equal((await offlineAdapter().resume(ref)).status, "failed");
    assert.deepEqual(readFileSync(ref.sessionFile), truncated);
    writeFileSync(ref.sessionFile, "");
    assert.equal((await offlineAdapter().resume(ref)).status, "failed");
    assert.equal(readFileSync(ref.sessionFile).length, 0);
  });

  it("ignores deferred records outside the current branch", async () => {
    const { manager, ref } = persistedSession();
    const fork = manager.getLeafId();
    manager.appendMessage({ ...assistant("deferred"), deferred: {
      provider: "relay-mock-deferred", modelId: "relay-mock-job", api: "relay-mock-jobs", id: "old-job" } });
    manager.branch(fork!);
    manager.appendMessage(assistant("stop", "current branch result"));
    const result = await offlineAdapter().resume(ref);
    assert.equal(result.status, "completed");
    assert.equal(result.output, "current branch result");
    assert.equal((await offlineAdapter().inspect(ref)).status, "idle");
  });

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

/**
 * PiTaskAdapter acceptance: a real Pi AgentSession created through public
 * APIs persists the deferred job reference; a NEW adapter instance (the
 * "restarted process") recovers it and continues through fetchDeferred —
 * the provider's submission count stays 1.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
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
  it("uses an injected configured runtime and isolates text-only calls from tools and project resources", async () => {
    const cwd = join(tmp, "isolation");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "PRIVATE_CONTEXT_CANARY");
    writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PRIVATE_SYSTEM_CANARY");
    const marker = join(cwd, "extension-loaded");
    writeFileSync(join(cwd, ".pi", "extensions", "canary.js"),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default () => {};`);
    let calls = 0;
    const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
    provider.streamSimple = (_model, context, options) => {
      calls += 1;
      assert.equal(context.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []).length, 0);
      assert.ok(!JSON.stringify(context).includes("PRIVATE_"));
      assert.equal(options?.maxRetries, 0);
      const events = createAssistantMessageEventStream();
      const message = assistant();
      events.push({ type: "done", reason: "stop", message });
      return events;
    };
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    modelRuntime.registerNativeProvider(provider);
    const adapter = new PiTaskAdapter({ model: mockDeferredModel(), modelRuntime,
      textOnly: true, cwd, sessionDir: join(cwd, "sessions") });
    const ref = await adapter.attach({ id: "isolated", goal: "synthetic instruction" });
    assert.equal((await adapter.resume(ref)).status, "completed");
    assert.equal(calls, 1);
    assert.equal(existsSync(marker), false);
    assert.ok(!readFileSync(ref.sessionFile!, "utf8").includes("PRIVATE_"));
    const reader = new PiTaskAdapter({ cwd, sessionDir: join(cwd, "sessions") });
    assert.equal((await reader.resume(ref)).output, "synthetic result");
    assert.equal(calls, 1, "read-only recovery needs neither a provider nor credentials");
  });

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

  for (const [label, content] of [
    ["no content blocks", []],
    ["empty text", [{ type: "text", text: "" }]],
    ["whitespace text", [{ type: "text", text: " \n\t\r " }]],
    ["thinking only", [{ type: "thinking", thinking: "synthetic reasoning" }]],
    ["empty text mixed with thinking", [{ type: "text", text: " " }, { type: "thinking", thinking: "synthetic reasoning" }]],
  ] satisfies [string, AssistantMessage["content"]][]) {
    it(`rejects deferred stop with ${label} and never authorizes continuation`, async () => {
      const { manager, ref } = persistedSession();
      const handle = { provider: "relay-mock-deferred", modelId: "relay-mock-job", api: "relay-mock-jobs", id: "empty-job" };
      manager.appendMessage({ ...assistant("deferred"), deferred: handle });
      const bytes = readFileSync(ref.sessionFile);
      const mtime = statSync(ref.sessionFile).mtimeMs;
      let polls = 0;
      let submissions = 0;
      const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
      provider.stream = provider.streamSimple = () => { submissions += 1; throw new Error("unexpected new submission"); };
      provider.fetchDeferred = (_model, actualHandle) => {
        polls += 1;
        assert.deepEqual(actualHandle, handle);
        const events = createAssistantMessageEventStream();
        events.push({ type: "done", reason: "stop", message: { ...assistant(), content } });
        return events;
      };
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
      modelRuntime.registerNativeProvider(provider);
      const adapter = new PiTaskAdapter({ model: mockDeferredModel(), modelRuntime,
        cwd: tmp, sessionDir: join(tmp, "persisted"), pollMs: 0, maxPolls: 3 });
      const result = await adapter.resume(ref);
      assert.equal(result.status, "failed");
      assert.equal(result.resumed, false);
      assert.equal(result.output, undefined);
      assert.match(result.detail ?? "", /empty/);
      assert.equal(polls, 1, "an empty final result is a failure, not another pending poll");

      const store = new MemoryTaskStore();
      const runtime = new TaskRuntime({ store, journal: new NopJournal() as never });
      const task = await runtime.createTask({ goal: "synthetic task", adapter: "pi", agentRef: ref });
      let continued = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await runtime.resume(task.id, { adapter,
          continuation: async () => { continued += 1; await runtime.complete(task.id); } });
        assert.equal(outcome.outcome, "blocked");
        if (outcome.outcome === "blocked") assert.equal(outcome.reason, "adapter");
      }
      assert.equal(continued, 0);
      assert.equal((await runtime.getTask(task.id))?.status, "WAITING");
      assert.equal((await runtime.pendingAwaits(task.id)).length, 1, "failed re-polls reuse the adapter wait");
      assert.equal(polls, 3);
      assert.equal(submissions, 0, "never resubmit the agent job");
      assert.deepEqual(readFileSync(ref.sessionFile), bytes);
      assert.equal(statSync(ref.sessionFile).mtimeMs, mtime);
    });
  }

  for (const reason of ["error", "aborted", "length", "toolUse", "setup-error"] as const) {
    it(`fails deferred ${reason} immediately instead of exhausting pending polls`, async () => {
      const { manager, ref } = persistedSession();
      manager.appendMessage({ ...assistant("deferred"), deferred: {
        provider: "relay-mock-deferred", modelId: "relay-mock-job", api: "relay-mock-jobs", id: "failed-job" } });
      const bytes = readFileSync(ref.sessionFile);
      const mtime = statSync(ref.sessionFile).mtimeMs;
      let polls = 0;
      let submissions = 0;
      const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
      provider.stream = provider.streamSimple = () => { submissions += 1; throw new Error("unexpected submission"); };
      provider.fetchDeferred = () => {
        polls += 1;
        const events = createAssistantMessageEventStream();
        if (reason === "error" || reason === "aborted") {
          events.push({ type: "error", reason, error: assistant(reason) });
        } else {
          events.push({ type: "done", reason: "stop", message: assistant(reason === "setup-error" ? "stop" : reason) });
        }
        return events;
      };
      const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
      modelRuntime.registerNativeProvider(reason === "setup-error" ? { ...provider,
        auth: { apiKey: { name: "synthetic failure", resolve: async () => { throw new Error("SENSITIVE_ERROR_CANARY"); } } },
      } : provider);
      const adapter = new PiTaskAdapter({ model: mockDeferredModel(), modelRuntime,
        cwd: tmp, sessionDir: join(tmp, "persisted"), pollMs: 0, maxPolls: 3 });
      const result = await adapter.resume(ref);
      assert.equal(result.status, "failed", JSON.stringify(result));
      assert.equal(result.resumed, false);
      assert.equal(result.output, undefined);
      assert.equal(result.detail, `deferred assistant ended with ${reason === "setup-error" ? "error" : reason}`);
      assert.ok(!JSON.stringify(result).includes("SENSITIVE_ERROR_CANARY"));
      assert.equal(polls, reason === "setup-error" ? 0 : 1);
      const runtime = new TaskRuntime({ store: new MemoryTaskStore(), journal: new NopJournal() as never });
      const task = await runtime.createTask({ goal: "synthetic task", adapter: "pi", agentRef: ref });
      let continued = 0;
      const outcome = await runtime.resume(task.id, { adapter, continuation: async () => { continued += 1; } });
      assert.equal(outcome.outcome, "blocked");
      assert.equal(continued, 0);
      assert.equal((await runtime.getTask(task.id))?.status, "WAITING");
      assert.equal((await runtime.pendingAwaits(task.id)).length, 1);
      assert.equal(submissions, 0);
      assert.deepEqual(readFileSync(ref.sessionFile), bytes);
      assert.equal(statSync(ref.sessionFile).mtimeMs, mtime);
    });
  }

  it("keeps genuine deferred polls pending and can complete on a later explicit resume", async () => {
    const { manager, ref } = persistedSession();
    const handle = { provider: "relay-mock-deferred", modelId: "relay-mock-job", api: "relay-mock-jobs", id: "pending-job" };
    manager.appendMessage({ ...assistant("deferred"), deferred: handle });
    let polls = 0;
    const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
    provider.fetchDeferred = () => {
      polls += 1;
      const events = createAssistantMessageEventStream();
      const message = polls <= 3 ? { ...assistant("deferred"), deferred: handle } : assistant();
      events.push({ type: "done", reason: "stop", message });
      return events;
    };
    const adapter = new PiTaskAdapter({ model: mockDeferredModel(), provider,
      cwd: tmp, sessionDir: join(tmp, "persisted"), pollMs: 0, maxPolls: 3 });
    assert.equal((await adapter.resume(ref)).status, "pending");
    assert.equal(polls, 3);
    assert.equal((await adapter.resume(ref)).status, "completed");
    assert.equal(polls, 4);
  });

  it("accepts nonempty deferred text fragments without trimming the returned output", async () => {
    const { manager, ref } = persistedSession();
    manager.appendMessage({ ...assistant("deferred"), deferred: {
      provider: "relay-mock-deferred", modelId: "relay-mock-job", api: "relay-mock-jobs", id: "valid-job" } });
    const provider = createMockDeferredProvider({ baseUrl: "http://127.0.0.1:1" });
    provider.fetchDeferred = () => {
      const events = createAssistantMessageEventStream();
      events.push({ type: "done", reason: "stop", message: { ...assistant(), content: [
        { type: "text", text: " \n" }, { type: "thinking", thinking: "not final output" },
        { type: "text", text: "有效结果" }, { type: "text", text: "\t " },
      ] } });
      return events;
    };
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    modelRuntime.registerNativeProvider(provider);
    const adapter = new PiTaskAdapter({ model: mockDeferredModel(), modelRuntime,
      cwd: tmp, sessionDir: join(tmp, "persisted") });
    assert.deepEqual(await adapter.resume(ref), {
      resumed: true, status: "completed", detail: "deferred run completed", output: " \n有效结果\t ",
    });
    const runtime = new TaskRuntime({ store: new MemoryTaskStore(), journal: new NopJournal() as never });
    const task = await runtime.createTask({ goal: "synthetic task", adapter: "pi", agentRef: ref });
    let continued = 0;
    const outcome = await runtime.resume(task.id, { adapter,
      continuation: async () => { continued += 1; await runtime.complete(task.id); } });
    assert.equal(outcome.outcome, "resumed");
    assert.equal(continued, 1);
    assert.equal((await runtime.getTask(task.id))?.status, "COMPLETED");
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
      assert.equal(result.resumed, true, JSON.stringify(result));
      assert.equal((result as { status?: string }).status, "completed");
      assert.ok(String(result.output).length > 0);

      // Resume again after the job completed: no second job submission.
      const again = await restarted.resume(ref);
      assert.equal(again.resumed, true, JSON.stringify(again));
      assert.equal((again as { status?: string }).status, "completed");

      assert.equal(server.submissions(), 1, "exactly one job submission across attach+restart+resume");
    } finally {
      await server.stop();
    }
  });
});

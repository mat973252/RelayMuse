/**
 * @relay/adapter-pi — Pi implementation of the core `AgentAdapter` port.
 *
 * One adapter, three duties, all through Pi's public surfaces only:
 *   - attach:   createAgentSession + SessionManager.create, prompt once,
 *               persist AgentRef (session file + deferred handle reference).
 *   - inspect:  public SessionManager projection of the exact file — read-only.
 *   - resume:   read a persisted synchronous result, or poll fetchDeferred
 *               through the public mechanism proven by the M5 fixture.
 *
 * Relay never reimplements the agent loop or DeferredHandle semantics; this
 * adapter only carries references and delegates every continuation to Pi.
 */
import type { AgentAdapter, AgentRef, AgentResumeResult, AgentState } from "@relay/core";
import type { Api, DeferredHandle, Model, Provider } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

export interface PiTaskAdapterOptions {
  /** Model the agent leg runs on (e.g. mockDeferredModel()). */
  model: Model<Api>;
  /** Provider to register on the ModelRuntime (e.g. createMockDeferredProvider()). */
  provider: Provider<Api>;
  /** Working directory handed to SessionManager.create. */
  cwd: string;
  /** Directory holding Pi session files (JSONL). */
  sessionDir: string;
  /** Poll interval for fetchDeferred (ms). Default 50. */
  pollMs?: number;
  /** Max fetchDeferred polls before giving up. Default 40. */
  maxPolls?: number;
}

export class PiTaskAdapter implements AgentAdapter {
  readonly id = "pi";

  private readonly options: PiTaskAdapterOptions;

  constructor(options: PiTaskAdapterOptions) {
    this.options = options;
  }

  /**
   * Start the agent leg: a real Pi AgentSession on the configured
   * model/provider, prompted once with the task instruction. The returned
   * AgentRef stores Pi references only — session file path and, when the
   * provider deferred, its DeferredHandle — never a session copy.
   */
  async attach(task: { id: string; goal: string }, context: { instruction?: string | undefined } = {}): Promise<AgentRef> {
    const { ModelRuntime, SessionManager, createAgentSession } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(this.options.provider);
    const sessionManager = SessionManager.create(this.options.cwd, this.options.sessionDir);
    const { session } = await createAgentSession({
      model: this.options.model,
      modelRuntime,
      sessionManager,
    });
    await session.prompt(context.instruction ?? task.goal);

    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();
    if (sessionFile === undefined || !sessionFile.endsWith(".jsonl")) {
      throw new Error(`pi attach: no session file materialized in ${this.options.sessionDir}`);
    }
    // Give the session a moment to flush the deferred assistant entry.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const persisted = await this.readSession({ sessionId, sessionFile });
    return {
      sessionId,
      sessionFile,
      deferredRef: persisted.handle,
    };
  }

  /** Read-only: does the persisted session exist and is a run deferred? */
  async inspect(ref: AgentRef): Promise<AgentState> {
    const persisted = await this.readSession(ref);
    return { status: persisted.handle !== undefined ? "waiting-deferred"
      : persisted.result.status === "completed" ? "idle" : "unknown",
      detail: persisted.result.detail };
  }

  /** Project only the referenced session's current branch; never repair its file. */
  private async readSession(ref: AgentRef): Promise<{ result: AgentResumeResult; handle?: DeferredHandle }> {
    const failed = (detail: string) => ({ result: { resumed: false, status: "failed" as const, detail } });
    if (ref.sessionFile === undefined) return failed("no session file reference");
    try {
      // Pi's disk loader skips malformed lines and may migrate/repair a file.
      // Parse strictly, then use the public in-memory projection for a read-only gate.
      const entries = (await readFile(ref.sessionFile, "utf8")).split("\n")
        .filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as FileEntry);
      const header = entries[0];
      if (header?.type !== "session" || typeof header.id !== "string"
        || (ref.sessionId !== undefined && header.id !== ref.sessionId)) {
        return failed("invalid or mismatched session header");
      }
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const manager = SessionManager.inMemory(this.options.cwd, undefined, entries);
      const finalEntry = manager.getBranch().filter((entry) => entry.type === "message" || entry.type === "custom_message").at(-1);
      const projected = manager.buildSessionProjection().entries.filter((entry) => entry.messages.length > 0).at(-1);
      // An omitted latest prompt/result must not expose an older success as final.
      if (finalEntry === undefined || projected?.sourceEntry.id !== finalEntry.id) {
        return failed("latest branch message has no projected result");
      }
      const message = projected.messages.at(-1);
      if (message?.role !== "assistant") return failed("no final assistant result on the current branch");
      if (message.stopReason === "deferred" && message.deferred !== undefined) {
        const handle = message.deferred;
        if (ref.deferredRef !== undefined && (ref.deferredRef.id !== handle.id
          || ref.deferredRef.provider !== handle.provider || ref.deferredRef.modelId !== handle.modelId
          || ref.deferredRef.api !== handle.api)) return failed("deferred reference does not match the current branch");
        return { result: { resumed: false, status: "pending", detail: `deferred job ${handle.id}` }, handle };
      }
      if (message.stopReason !== "stop") return failed(`assistant ended with ${message.stopReason}`);
      const output = message.content.map((part) => part.type === "text" ? part.text : "").join("");
      if (output.trim().length === 0) return failed("final assistant result is empty");
      return { result: { resumed: false, status: "completed", detail: "persisted assistant result", output } };
    } catch {
      return failed("session is missing, corrupt or unreadable");
    }
  }

  /**
   * Continue the agent side: poll Pi's fetchDeferred on the persisted
   * handle until it completes, or return a validated persisted synchronous
   * result. Missing or failed agent results never authorize continuation.
   */
  async resume(ref: AgentRef): Promise<AgentResumeResult> {
    const persisted = await this.readSession(ref);
    const handle = persisted.handle;
    if (handle === undefined) return persisted.result;

    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(this.options.provider);

    const pollMs = this.options.pollMs ?? 50;
    const maxPolls = this.options.maxPolls ?? 40;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const result = await modelRuntime.fetchDeferred(this.options.model, {
        provider: handle.provider,
        modelId: handle.modelId,
        api: handle.api,
        id: handle.id,
      });
      if (result.stopReason === "stop") {
        const text = result.content?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
        return { resumed: true, status: "completed", detail: "deferred run completed", output: text };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return {
      resumed: false,
      status: "pending",
      detail: `deferred run still pending after ${String(maxPolls)} polls`,
    };
  }
}

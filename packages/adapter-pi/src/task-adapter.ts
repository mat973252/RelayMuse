/**
 * @relay/adapter-pi — Pi implementation of the core `AgentAdapter` port.
 *
 * One adapter, three duties, all through Pi's public surfaces only:
 *   - attach:   createAgentSession + SessionManager.create, prompt once,
 *               persist AgentRef (session file + deferred handle reference).
 *   - inspect:  SessionManager.open + session-file scan — read-only.
 *   - resume:   ModelRuntime.fetchDeferred polling, the same documented
 *               mechanism the M5 fixture proves across processes.
 *
 * Relay never reimplements the agent loop or DeferredHandle semantics; this
 * adapter only carries references and delegates every continuation to Pi.
 */
import type { AgentAdapter, AgentRef, AgentState } from "@relay/core";
import type { Api, DeferredHandle, Model, Provider } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverDeferred } from "./deferred.js";

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

    const sessionId = (sessionManager as unknown as { sessionId?: string }).sessionId;
    const knownFile = (sessionManager as unknown as { sessionFile?: string }).sessionFile;
    const sessionFile =
      knownFile ??
      join(
        this.options.sessionDir,
        (await readdir(this.options.sessionDir)).find((name) => name.endsWith(".jsonl")) ?? "",
      );
    if (!sessionFile.endsWith(".jsonl")) {
      throw new Error(`pi attach: no session file materialized in ${this.options.sessionDir}`);
    }
    // Give the session a moment to flush the deferred assistant entry.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deferred = (await discoverDeferred(this.options.sessionDir)).find(
      (found) => found.sessionFile === sessionFile,
    );
    return {
      sessionId,
      sessionFile,
      deferredRef: deferred?.handle,
    };
  }

  /** Read-only: does the persisted session exist and is a run deferred? */
  async inspect(ref: AgentRef): Promise<AgentState> {
    if (ref.sessionFile === undefined || !existsSync(ref.sessionFile)) {
      return { status: "unknown", detail: `no session file at ${ref.sessionFile ?? "<none>"}` };
    }
    const discovered = await discoverDeferred(
      join(ref.sessionFile, ".."),
    );
    const pending = discovered.find((found) => found.sessionFile === ref.sessionFile);
    return pending === undefined
      ? { status: "idle", detail: "session exists; no deferred run persisted" }
      : { status: "waiting-deferred", detail: `deferred job ${pending.handle.id}` };
  }

  /**
   * Continue the agent side: poll Pi's fetchDeferred on the persisted
   * handle until it completes. If the task has no deferred ref, rescan the
   * session file first — a crash between attach and ref persistence still
   * recovers.
   */
  async resume(ref: AgentRef): Promise<{ resumed: boolean; detail?: string | undefined; output?: unknown }> {
    if (ref.sessionFile === undefined) {
      return { resumed: false, detail: "no session file reference" };
    }
    let handle: DeferredHandle | undefined = ref.deferredRef;
    if (handle === undefined) {
      const discovered = await discoverDeferred(join(ref.sessionFile, ".."));
      handle = discovered.find((found) => found.sessionFile === ref.sessionFile)?.handle;
    }
    if (handle === undefined) {
      return { resumed: false, detail: "no deferred run to continue" };
    }

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
        return { resumed: true, detail: "deferred run completed", output: text };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { resumed: false, detail: `deferred run still pending after ${String(maxPolls)} polls` };
  }
}

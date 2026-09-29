/**
 * @relay/adapter-pi — deferred-response migration seam (M5).
 *
 * Uses only public Pi surfaces:
 *   - `DeferredHandle` + `Provider` + `Model` contracts from @earendil-works/pi-ai
 *   - `ModelRuntime.registerNativeProvider()` / `ModelRuntime.fetchDeferred()`
 *   - the documented Pi session JSONL format (docs/session-format.md) for
 *     discovery of persisted deferred assistant messages.
 *
 * Relay NEVER redefines DeferredHandle semantics or the agent loop; it only
 * discovers handles, carries them across migration, and resumes them through
 * Pi's own fetchDeferred API.
 */
import type {
  Api,
  AssistantMessage,
  DeferredHandle,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface MockDeferredProviderOptions {
  /** Base URL of the local job server (POST /jobs, GET /jobs/:id). */
  baseUrl: string;
  providerId?: string;
}

export const MOCK_PROVIDER_ID = "relay-mock-deferred";
export const MOCK_MODEL_ID = "relay-mock-job";
export const MOCK_API: Api = "relay-mock-jobs";

/** The single model served by the mock deferred provider. */
export function mockDeferredModel(providerId: string = MOCK_PROVIDER_ID): Model<Api> {
  return {
    id: MOCK_MODEL_ID,
    name: "Relay Mock Deferred Job",
    api: MOCK_API,
    provider: providerId,
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function usage(): AssistantMessage["usage"] {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  // Connection: close keeps the socket out of undici's keep-alive pool — a
  // pooled handle mid-close during process.exit() hits the unfixed upstream
  // Windows libuv assert (nodejs/node#56645, undici#5680).
  const res = await fetch(url, { headers: { connection: "close" } });
  if (!res.ok) throw new Error(`job server HTTP ${String(res.status)} for ${url}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A native Pi provider whose `stream()` submits exactly one job to the local
 * job server and immediately returns a DEFERRED assistant message (the
 * provider contract for responses that complete later), and whose
 * `fetchDeferred()` polls the same job — never re-submitting it.
 */
export function createMockDeferredProvider(options: MockDeferredProviderOptions): Provider<Api> {
  const providerId = options.providerId ?? MOCK_PROVIDER_ID;
  const model = mockDeferredModel(providerId);
  const submit = async (): Promise<string> => {
    const res = await fetch(new URL("/js", options.baseUrl), {
      method: "POST",
      headers: { connection: "close" },
    });
    if (!res.ok) throw new Error(`job server submit failed: ${String(res.status)}`);
    const body = (await res.json()) as { jobId: string };
    return body.jobId;
  };

  const deferredMessage = (jobId: string): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text: `job ${jobId} submitted; response pending` }],
    api: MOCK_API,
    provider: providerId,
    model: MOCK_MODEL_ID,
    usage: usage(),
    stopReason: "deferred",
    timestamp: Date.now(),
    deferred: {
      provider: providerId,
      modelId: MOCK_MODEL_ID,
      api: MOCK_API,
      id: jobId,
      pollAfterMs: 50,
    },
  });

  const streamFrom = (produce: () => Promise<AssistantMessage>) => {
    const events = createAssistantMessageEventStream();
    void (async () => {
      try {
        const message = await produce();
        events.push({ type: "start", partial: message });
        events.push({ type: "done", reason: "stop", message });
      } catch (err) {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          api: MOCK_API,
          provider: providerId,
          model: MOCK_MODEL_ID,
          usage: usage(),
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        events.push({ type: "error", reason: "error", error: message });
      }
    })();
    return events;
  };

  return {
    id: providerId,
    name: "Relay Mock Deferred Provider",
    auth: {
      apiKey: {
        name: "Relay mock (ambient)",
        resolve: async () => ({ auth: { apiKey: "relay-mock" }, source: "relay mock" }),
      },
    },
    getModels: () => [model],
    stream: (_model, _context) =>
      streamFrom(async () => deferredMessage(await submit())),
    streamSimple: (_model, _context) =>
      streamFrom(async () => deferredMessage(await submit())),
    fetchDeferred: (_model, handle: DeferredHandle) =>
      streamFrom(async () => {
        const body = await getJson(new URL(`/js/${handle.id}`, options.baseUrl).href);
        if (body.status === "complete") {
          return {
            role: "assistant",
            content: [{ type: "text", text: String(body.result ?? "") }],
            api: MOCK_API,
            provider: providerId,
            model: MOCK_MODEL_ID,
            usage: usage(),
            stopReason: "stop",
            timestamp: Date.now(),
          } satisfies AssistantMessage;
        }
        // Still pending: keep the SAME handle (Pi contract: deferred again).
        return deferredMessage(handle.id);
      }),
  };
}

/** A deferred assistant message found in a Pi session file. */
export interface DiscoveredDeferred {
  sessionFile: string;
  sessionId: string | undefined;
  entryId: string | undefined;
  handle: DeferredHandle;
}

interface SessionLine {
  id?: unknown;
  sessionId?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    stopReason?: unknown;
    deferred?: unknown;
  };
}

function isDeferredHandle(value: unknown): value is DeferredHandle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.provider === "string" && typeof v.id === "string" && typeof v.modelId === "string";
}

/**
 * Scans a Pi session directory (JSONL files, documented session format) for
 * assistant messages persisted in the deferred state. Read-only discovery:
 * this never mutates Pi state.
 */
export async function discoverDeferred(sessionDir: string): Promise<DiscoveredDeferred[]> {
  const found: DiscoveredDeferred[] = [];
  const names = await readdir(sessionDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionFile = join(sessionDir, name);
    const raw = await readFile(sessionFile, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: SessionLine;
      try {
        parsed = JSON.parse(trimmed) as SessionLine;
      } catch {
        continue;
      }
      const message = parsed.message;
      if (
        typeof message === "object" &&
        message !== null &&
        message.role === "assistant" &&
        message.stopReason === "deferred" &&
        isDeferredHandle(message.deferred)
      ) {
        found.push({
          sessionFile,
          sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
          entryId: typeof parsed.id === "string" ? parsed.id : undefined,
          handle: message.deferred,
        });
      }
    }
  }
  return found;
}

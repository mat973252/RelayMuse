// Explicit opt-in only. Pi loads credentials; Relay persists references/results.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { effects, run as checkPackage, continuation } from "./pi-muse-runtime.mjs";

if (process.env.MUSE_REAL_OPT_IN !== "1") throw new Error("real provider requires explicit opt-in");
const CWD = process.cwd();
const SESSION_DIR = join(CWD, ".relay", "sessions");
const REQUESTS = join(CWD, ".relay", "model-requests.jsonl");
const { PiTaskAdapter } = await import(new URL("../../packages/adapter-pi/dist/src/index.js", import.meta.url));
const reader = new PiTaskAdapter({ cwd: CWD, sessionDir: SESSION_DIR });
export const EXPECTED = "RELAYMUSE_REAL_PROVIDER_OK";
export { effects, continuation };

export const adapter = {
  id: "pi",
  async attach(task, context) {
    const { ModelRuntime } = await import(new URL("../../packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url));
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    const selected = runtime.getModel(process.env.MUSE_MODEL_PROVIDER, process.env.MUSE_MODEL_ID);
    if (selected === undefined) throw new Error("requested configured model is unavailable; no fallback");
    mkdirSync(join(CWD, ".relay"), { recursive: true });
    const streamSimple = runtime.streamSimple.bind(runtime);
    // Instrument the public Pi request boundary. No credentials, headers or payloads logged.
    runtime.streamSimple = (model, input, options) => {
      if (existsSync(REQUESTS) && readFileSync(REQUESTS, "utf8").trim().length > 0) {
        throw new Error("one-model-call budget exhausted");
      }
      appendFileSync(REQUESTS, JSON.stringify({ event: "request", provider: model.provider,
        model: model.id, at: Date.now(), maxTokens: 64, tools: input.tools?.length ?? 0 }) + "\n");
      const stream = streamSimple(model, input, { ...options, maxTokens: 64, maxRetries: 0 });
      void stream.result().then((result) => {
        const text = result.content.filter((p) => p.type === "text").map((p) => p.text).join("");
        appendFileSync(REQUESTS, JSON.stringify({ event: "result", stopReason: result.stopReason,
          outputMatches: text.trim() === EXPECTED,
          outputSha256: createHash("sha256").update(text).digest("hex"),
          usage: { input: result.usage.input, output: result.usage.output, totalTokens: result.usage.totalTokens } }) + "\n");
      });
      return stream;
    };
    return new PiTaskAdapter({ model: { ...selected, maxTokens: 64 }, modelRuntime: runtime,
      textOnly: true, cwd: CWD, sessionDir: SESSION_DIR }).attach(task, context);
  },
  inspect: (ref) => reader.inspect(ref),
  resume: (ref) => reader.resume(ref),
};

export async function run(ctx) {
  const result = await reader.resume(ctx.task.agentRef ?? {});
  if (result.status !== "completed" || String(result.output).trim() !== EXPECTED) {
    await ctx.runtime.blockTask(ctx.task.id, "real-model-result-not-verified");
    process.stdout.write("real model result rejected; no approval or publish\n");
    return;
  }
  await checkPackage(ctx); // The model never replaces the real package test or human approval.
}

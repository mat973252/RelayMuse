import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const demo = fileURLToPath(new URL("../../../../examples/pi-muse/real-provider-demo.mjs", import.meta.url));
const marker = "RELAYMUSE_REAL_PROVIDER_OK";
const credentialCanary = "SYNTHETIC_CREDENTIAL_CANARY";

function child(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [demo, ...args], { env });
    let out = "", err = "";
    proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.on("data", (c) => { err += c; });
    proc.on("error", reject);
    const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe("opt-in configured Pi provider demo (offline HTTP fixture)", () => {
  it("requires opt-in and explicit approval of the local fixture", async () => {
    const result = await child(["--provider", "fixture", "--model", "synthetic"]);
    assert.equal(result.code, 64);
    assert.match(result.err, /--opt-in --approve-fixture/);
  });

  for (const failed of [false, true]) {
    it(failed ? "model failure leaves BLOCKED with no publish and no model retry"
      : "one configured model request survives approval, kill and competing recovery", { timeout: 180_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), "relay-real-provider-test-"));
      const agentDir = join(root, "agent");
      const evidence = join(root, "evidence");
      mkdirSync(agentDir);
      let requests = 0;
      const violations: string[] = [];
      const server = createServer((req, res) => {
        if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          requests += 1;
          const payload = JSON.parse(raw) as { tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number };
          if ((payload.tools?.length ?? 0) !== 0 || raw.includes("PRIVATE_CONTEXT_CANARY")) violations.push("context isolation");
          if ((payload.max_tokens ?? payload.max_completion_tokens ?? Infinity) > 64) violations.push("token limit");
          if (failed) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "synthetic rejection" } })); return; }
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = { id: "synthetic", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "synthetic" };
          res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: credentialCanary,
        models: [{ id: "synthetic", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 64 }],
      } } }));
      writeFileSync(join(agentDir, "AGENTS.md"), "PRIVATE_CONTEXT_CANARY");
      try {
        const result = await child(["--opt-in", "--approve-fixture", "--provider", "fixture", "--model", "synthetic", "--evidence", evidence],
          { ...process.env, PI_CODING_AGENT_DIR: agentDir });
        const summary = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8")) as {
          status: string; remote: { publishRequests: number; mutations: number }; piModelRequests?: number;
        };
        assert.equal(requests, 1, readFileSync(join(evidence, "result.json"), "utf8"));
        assert.deepEqual(violations, []);
        if (failed) {
          assert.equal(result.code, 1);
          assert.equal(summary.status, "FAIL");
          assert.equal(summary.remote.publishRequests, 0);
          const snapshot = JSON.parse(readFileSync(join(evidence, "waiting.json"), "utf8")) as { status: string; waitingFor: unknown[]; artifacts: unknown[] };
          assert.equal(snapshot.status, "BLOCKED");
          assert.equal(snapshot.waitingFor.length, 0, "model failure does not create an approval wait");
          assert.equal(snapshot.artifacts.length, 0);
        } else {
          assert.equal(result.code, 0, result.out + result.err);
          assert.equal(summary.status, "PASS");
          assert.equal(summary.piModelRequests, 1);
          assert.equal(summary.remote.publishRequests, 1);
          assert.equal(summary.remote.mutations, 1);
        }
        for (const file of files(evidence)) {
          assert.ok(!readFileSync(file).includes(Buffer.from(credentialCanary)), "credential must not enter durable evidence");
          assert.ok(!readFileSync(file).includes(Buffer.from("PRIVATE_CONTEXT_CANARY")), "personal context must not enter durable evidence");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

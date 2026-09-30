// One real Pi model call; all mutations stay on the loopback release fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startReleaseServer } from "./fixtures/release-server.mjs";

const args = process.argv.slice(2);
function value(flag) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
const provider = value("--provider");
const model = value("--model");
if (!args.includes("--opt-in") || !args.includes("--approve-fixture") || !provider || !model) {
  console.error("Usage: node examples/pi-muse/real-provider-demo.mjs --opt-in --approve-fixture --provider ID --model ID [--evidence DIR]");
  process.exit(64);
}
const ws = value("--evidence") ? resolve(value("--evidence")) : mkdtempSync(join(tmpdir(), "relay-real-pi-"));
mkdirSync(ws, { recursive: true });
if (existsSync(join(ws, ".relay"))) throw new Error("use a new evidence directory; existing durable state is preserved");
const CLI = fileURLToPath(new URL("../../packages/cli/dist/src/cli.js", import.meta.url));
const MODULE = fileURLToPath(new URL("./real-provider-runtime.mjs", import.meta.url));
const server = await startReleaseServer();
const env = { ...process.env, MUSE_SERVER_URL: server.baseUrl, MUSE_RELEASE_KEY: "real-pi-synthetic-release",
  MUSE_REAL_OPT_IN: "1", MUSE_MODEL_PROVIDER: provider, MUSE_MODEL_ID: model };
const summary = { checkedAt: new Date().toISOString(), status: "FAIL", provider, model,
  boundary: "Real model via Pi; synthetic package and loopback publish fixture; Pi-side request count only.",
  checks: [], commands: [] };
function check(label, ok) { summary.checks.push({ label, ok }); assert.ok(ok, label); }
async function relay(argv, extra = {}) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [CLI, "task", ...argv], { cwd: ws, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      summary.commands.push({ argv, status, signal, stdout: out,
        stderrSha256: createHash("sha256").update(err).digest("hex") });
      resolveChild({ status, signal, out });
    });
  });
}
async function show(id, name) {
  const result = await relay(["show", id]);
  assert.equal(result.status, 0, "snapshot query succeeded");
  const snapshot = JSON.parse(result.out);
  writeFileSync(join(ws, `${name}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}
try {
  const run = await relay(["run", "--adapter-module", MODULE, "Return exactly: RELAYMUSE_REAL_PROVIDER_OK"]);
  summary.taskId = /task ([0-9a-f-]{36})/.exec(run.out)?.[1];
  check("task created", typeof summary.taskId === "string");
  const before = await show(summary.taskId, "waiting");
  check("real model verified and task waiting for approval", run.status === 0 && before.status === "WAITING"
    && before.waitingFor.some((a) => a.kind === "APPROVAL"));
  const sessionBefore = readFileSync(before.agentRef.sessionFile);
  summary.sessionSha256 = createHash("sha256").update(sessionBefore).digest("hex");
  const premature = await relay(["resume", summary.taskId, "--adapter-module", MODULE]);
  check("premature resume blocked", premature.status === 1 && premature.out.includes("await-pending"));
  check("no publish before approval", (await server.state()).publishRequests === 0);
  check("first approval resolves once", (await relay(["approve", summary.taskId])).out.includes("resolved-awaits 1"));
  check("duplicate approval is a no-op", (await relay(["approve", summary.taskId])).out.includes("resolved-awaits 0"));
  const killed = await relay(["resume", summary.taskId, "--adapter-module", MODULE], { MUSE_CRASH_AFTER_PUBLISH: "1" });
  check("process killed after fixture commit", (killed.signal === "SIGKILL" || (process.platform === "win32" && killed.status !== 0))
    && existsSync(join(ws, ".relay", "kill-intent")) && !existsSync(join(ws, ".relay", "after-kill"))
    && (await server.state()).publishRequests === 1);
  const uncertain = await show(summary.taskId, "after-crash");
  check("unsettled effect survives kill", uncertain.unresolvedEffects.length === 1);
  // Two fresh processes compete to recover the same killed task.
  const recovered = await Promise.all([relay(["resume", summary.taskId, "--adapter-module", MODULE]),
    relay(["resume", summary.taskId, "--adapter-module", MODULE])]);
  check("one recovery succeeds", recovered.some((r) => r.status === 0));
  const done = await show(summary.taskId, "completed");
  check("task completed with confirmed publish", done.status === "COMPLETED" && done.confirmed.includes("publish")
    && done.unresolvedEffects.length === 0);
  check("terminal resume is a no-op", (await relay(["resume", summary.taskId, "--adapter-module", MODULE])).out.includes("already"));
  summary.remote = await server.state();
  check("one fixture POST and one mutation", summary.remote.publishRequests === 1 && summary.remote.mutations === 1);
  const requests = readFileSync(join(ws, ".relay", "model-requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  summary.piModelRequests = requests.filter((r) => r.event === "request").length;
  summary.modelResult = requests.find((r) => r.event === "result");
  check("one Pi model request across all restarts", summary.piModelRequests === 1 && summary.modelResult?.outputMatches === true);
  check("session unchanged across recovery", readFileSync(done.agentRef.sessionFile).equals(sessionBefore));
  const { ArtifactStore } = await import(new URL("../../packages/artifact-fs/dist/src/index.js", import.meta.url));
  const store = await ArtifactStore.open({ root: join(ws, ".relay", "artifacts") });
  const receiptLink = done.artifacts.find((a) => a.role === "generated");
  const receipt = await store.resolve(receiptLink?.artifactId ?? "");
  const lineage = receipt ? await store.lineage(receipt.id) : undefined;
  check("receipt lineage and artifacts intact", lineage?.problems.length === 0
    && lineage.root.parents.length === 1 && lineage.root.parents[0].parents.length === 1
    && (await store.verify()).problems.length === 0);
  const events = await relay(["events", summary.taskId, "--json"]);
  const chain = JSON.parse(events.out).events;
  summary.resumeEvents = chain.filter((e) => e.type === "TASK_RESUMED").length;
  check("concurrent recovery has no extra continuation", summary.resumeEvents === 2);
  summary.status = "PASS";
} catch (error) {
  // Assertion labels are ours; never echo provider error payloads or personal config.
  summary.failure = error instanceof assert.AssertionError ? error.message : "demo failed; inspect durable local state";
  summary.remote = await server.state();
  process.exitCode = 1;
} finally {
  await server.stop();
  writeFileSync(join(ws, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, checks: summary.checks.length,
    piModelRequests: summary.piModelRequests, remote: summary.remote, evidence: ws }));
}

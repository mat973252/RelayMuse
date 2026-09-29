/**
 * pi-muse runtime module — the app-side code the CLI's --adapter-module seam
 * loads into `relay task run` / `relay task resume`. This is where the
 * Release Assistant's own effect specs and orchestration live; Relay core
 * provides the durable task/journal machinery, Pi provides the agent leg.
 *
 * Env (set by demo.mjs):
 *   MUSE_SERVER_URL            release server base URL
 *   MUSE_SESSION_DIR           Pi session dir (default <cwd>/.relay/sessions)
 *   MUSE_RELEASE_KEY           remote mutation key (default release-pkg-1)
 *   MUSE_CRASH_AFTER_PUBLISH=1 SIGKILL inside execute() AFTER the remote
 *                              commit — exercises the UNKNOWN/reconcile path.
 */
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ADAPTER = new URL("../../packages/adapter-pi/dist/src/index.js", import.meta.url).href;
const ARTIFACT = new URL("../../packages/artifact-fs/dist/src/index.js", import.meta.url).href;
const STORAGE = new URL("../../packages/storage-sqlite/dist/src/index.js", import.meta.url).href;

const { PiTaskAdapter, createMockDeferredProvider, mockDeferredModel } = await import(ADAPTER);
const { ArtifactStore } = await import(ARTIFACT);
const { SqliteEpistemicStore } = await import(STORAGE);

const BASE = process.env.MUSE_SERVER_URL;
if (BASE === undefined) throw new Error("MUSE_SERVER_URL is required");
const CWD = process.cwd();
const SESSION_DIR = process.env.MUSE_SESSION_DIR ?? join(CWD, ".relay", "sessions");
const ARTIFACTS = join(CWD, ".relay", "artifacts");
const DB = join(CWD, ".relay", "storage.db");
const RELEASE_KEY = process.env.MUSE_RELEASE_KEY ?? "release-pkg-1";
const PKG_DIR = join(CWD, ".relay", "pkg");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Minimal synthetic package the readiness check exercises. Local files only —
 * clearly a test fixture, never a real model or remote service. The test
 * exits 1 when MUSE_PKG_FAIL=1 (the controllable failure leg).
 */
function ensureSyntheticPackage() {
  mkdirSync(PKG_DIR, { recursive: true });
  writeFileSync(
    join(PKG_DIR, "package.json"),
    `${JSON.stringify({ name: "pi-muse-synthetic-pkg", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    join(PKG_DIR, "test.mjs"),
    `// Synthetic package check — a real child process; MUSE_PKG_FAIL=1 forces exit 1.\nif (process.env.MUSE_PKG_FAIL === "1") {\n  process.stderr.write("FAIL: synthetic package check failed\\n");\n  process.exit(1);\n}\nprocess.stdout.write("PASS: synthetic package check\\n");\n`,
  );
}

/** Manifest of the synthetic package (content digests — the lineage root). */
function packageManifest() {
  const lines = ["synthetic package manifest"];
  for (const name of readdirSync(PKG_DIR).sort()) {
    const content = readFileSync(join(PKG_DIR, name));
    lines.push(`file ${name} sha256=${sha256(content)} bytes=${content.byteLength}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Run the synthetic package's real test command and return the evidence.
 * The result comes from an actual child exit code — never a canned string.
 */
function runPackageCheck() {
  ensureSyntheticPackage();
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, ["test.mjs"], {
    cwd: PKG_DIR,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const finishedAt = Date.now();
  const exitCode = res.status ?? -1;
  const rel = relative(CWD, PKG_DIR);
  return {
    pass: res.status === 0,
    content:
      `release readiness check\n` +
      `command=${process.execPath} ${rel}/test.mjs\n` +
      `cwd=${rel}\n` +
      `exitCode=${exitCode}\n` +
      `result=${exitCode === 0 ? "pass" : "fail"}\n` +
      `startedAt=${startedAt}\n` +
      `finishedAt=${finishedAt}\n` +
      `stdoutSha256=${sha256(res.stdout ?? "")}\n` +
      `stderrSha256=${sha256(res.stderr ?? "")}\n` +
      `stdout=${(res.stdout ?? "").trim()}\n` +
      `stderr=${(res.stderr ?? "").trim()}\n`,
  };
}

export const adapter = new PiTaskAdapter({
  model: mockDeferredModel(),
  provider: createMockDeferredProvider({ baseUrl: BASE }),
  cwd: CWD,
  sessionDir: SESSION_DIR,
  pollMs: 50,
});

const publishSpec = {
  name: "publish",
  kind: "http/publish",
  request: { key: RELEASE_KEY },
  intent: `publish ${RELEASE_KEY} to the release server`,
  approvalRequired: true,
  execute: async () => {
    // connection: close keeps the socket out of undici's keep-alive pool —
    // a pooled handle mid-close during process.exit() trips libuv's Windows
    // UV_HANDLE_CLOSING assert (nodejs/node#56645, reproduced on Node 24.13).
    const res = await fetch(`${BASE}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ key: RELEASE_KEY }),
    });
    if (!res.ok) throw new Error(`publish failed: HTTP ${String(res.status)}`);
    const out = await res.json();
    // Chaos seam: the remote committed; the process dies before the local
    // journal learns the outcome -> the record stays SUBMITTED.
    if (process.env.MUSE_CRASH_AFTER_PUBLISH === "1") {
      process.kill(process.pid, "SIGKILL");
    }
    return out;
  },
  // The journal keeps requestHash, not the request body — the release key
  // comes from the spec's own configuration.
  reconcile: async () => {
    const res = await fetch(`${BASE}/effects/${encodeURIComponent(RELEASE_KEY)}`, {
      headers: { connection: "close" },
    });
    if (!res.ok) return { found: false, reason: "remote has no record of this publish" };
    const out = await res.json();
    return { found: true, remoteRef: out.remoteRef, result: out };
  },
};

export const effects = [publishSpec];

async function openEpi() {
  return SqliteEpistemicStore.open({ path: DB });
}

/** First leg of `task run`: really test the package, persist evidence, gate publish. */
export async function run({ runtime, task }) {
  // 1. Package manifest -> lineage root artifact.
  const store = await ArtifactStore.open({ root: ARTIFACTS });
  ensureSyntheticPackage();
  const pkgRecord = await store.write({
    content: packageManifest(),
    mediaType: "text/plain",
    producer: { type: "tool", id: "release-check" },
    refs: { run: task.id },
  });
  await runtime.linkArtifact(task.id, pkgRecord.artifactId, "input");

  // 2. Real test run — child exit code + command + output digests + timing
  //    land as evidence, as a CHILD of the package manifest record.
  const check = runPackageCheck();
  const report = await store.write({
    content: check.content,
    mediaType: "text/plain",
    producer: { type: "tool", id: "release-check" },
    parents: [pkgRecord.id],
    refs: { run: task.id },
  });
  await runtime.linkArtifact(task.id, report.artifactId, "evidence");

  // 3. Epistemic spine: the releasable belief is derived from the REAL exit
  //    code — a failing test yields a rejected belief, never an accepted one.
  const epi = await openEpi();
  const investigationId = `inv-${task.id}`;
  await epi.createInvestigation({
    id: investigationId,
    title: "release readiness",
    goal: task.goal,
    scope: `task:${task.id}`,
    status: "open",
    createdAt: Date.now(),
    closedAt: undefined,
  });
  await runtime.attachInvestigation(task.id, investigationId);
  await epi.addClaim({
    id: `claim-${task.id}`,
    investigationId,
    statement: `package ${RELEASE_KEY} is releasable`,
    createdAt: Date.now(),
  });
  await epi.addEvidence({
    id: `ev-${task.id}`,
    claimId: `claim-${task.id}`,
    ref: { kind: "artifact", ref: report.artifactId },
    supports: check.pass,
    observedAt: Date.now(),
  });
  await epi.putBelief({
    id: `belief-${task.id}`,
    claimId: `claim-${task.id}`,
    scope: `task:${task.id}`,
    confidence: check.pass ? 0.9 : 0.1,
    status: check.pass ? "accepted" : "rejected",
    basedOn: [`ev-${task.id}`],
    updatedAt: Date.now(),
  });
  epi.close();

  // 4. A failed package test blocks the publish before any approval wait —
  //    the task is parked BLOCKED with the failure as the reason.
  if (!check.pass) {
    await runtime.blockTask(task.id, "package-tests-failed");
    process.stdout.write(`publish decision: blocked (package tests failed: exit non-zero)\n`);
    return;
  }

  // 5. The gated mutation: ASK -> APPROVAL await -> task parks WAITING.
  const outcome = await runtime.runTaskEffect(task.id, publishSpec);
  process.stdout.write(`publish decision: ${outcome.decision}\n`);
}

/**
 * `task resume` continuation: publish (approved or reconciled), receipt, done.
 * A success receipt + completion require a CONFIRMED outcome only — a failed
 * or still-unknown publish never writes success evidence or completes the
 * task. UNKNOWN is reconciled by the resume gate (read-only, never re-POST).
 */
export async function continuation({ runtime, task }) {
  // Re-verify the readiness belief — a rejected/missing belief refuses the
  // publish decision and the success receipt, then parks the task BLOCKED.
  const epi = await openEpi();
  const belief = await epi.beliefFor(`claim-${task.id}`);
  epi.close();
  if (belief?.status !== "accepted") {
    await runtime.blockTask(task.id, "release-readiness-not-accepted");
    process.stdout.write(`publish refused: release readiness not established (belief=${belief?.status ?? "none"})\n`);
    return;
  }

  const outcome = await runtime.runTaskEffect(task.id, publishSpec);
  process.stdout.write(`publish decision after resume: ${outcome.decision}\n`);

  if (outcome.decision !== "executed" || outcome.outcome.status !== "confirmed") {
    process.stdout.write(
      `publish not confirmed (${outcome.decision}${outcome.outcome !== undefined ? `/${outcome.outcome.status}` : ""})\n`,
    );
    return;
  }

  const store = await ArtifactStore.open({ root: ARTIFACTS });
  // The receipt's lineage parent is the test-evidence artifact — the chain
  // package -> test evidence -> publish receipt is verifiable, not asserted.
  const links = await runtime.taskArtifacts(task.id);
  const parents = [];
  for (const link of links) {
    if (link.role !== "evidence") continue;
    const record = await store.resolve(link.artifactId);
    if (record !== undefined) parents.push(record.id);
  }
  const receipt = await store.write({
    content: `release receipt\nkey=${RELEASE_KEY}\neffect=${outcome.effectId}\n`,
    mediaType: "text/plain",
    producer: { type: "tool", id: "release-publish" },
    parents,
    refs: { run: task.id },
  });
  await runtime.linkArtifact(task.id, receipt.artifactId, "generated");

  const epi2 = await openEpi();
  await epi2.putDecision({
    id: `decision-${task.id}`,
    investigationId: `inv-${task.id}`,
    summary: `release ${RELEASE_KEY} approved and published`,
    reason: "high-impact",
    createdAt: Date.now(),
    resolvedAt: Date.now(),
  });
  epi2.close();
  await runtime.complete(task.id);
}

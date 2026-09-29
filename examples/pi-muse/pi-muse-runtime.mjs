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
import { join } from "node:path";

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

/** First leg of `task run`: check the package, persist evidence, gate publish. */
export async function run({ runtime, task }) {
  // 1. "Check package" — evidence lands as a content-addressed artifact.
  const store = await ArtifactStore.open({ root: ARTIFACTS });
  const report = await store.write({
    content: `release check for "${task.goal}"\nkey=${RELEASE_KEY}\nresult=pass\n`,
    mediaType: "text/plain",
    producer: { type: "tool", id: "release-check" },
    refs: { run: task.id },
  });
  await runtime.linkArtifact(task.id, report.artifactId, "evidence");

  // 2. Epistemic spine: an investigation, one claim, the evidence attached.
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
    supports: true,
    observedAt: Date.now(),
  });
  await epi.putBelief({
    id: `belief-${task.id}`,
    claimId: `claim-${task.id}`,
    scope: `task:${task.id}`,
    confidence: 0.9,
    status: "accepted",
    basedOn: [`ev-${task.id}`],
    updatedAt: Date.now(),
  });
  epi.close();

  // 3. The gated mutation: ASK -> APPROVAL await -> task parks WAITING.
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
  const outcome = await runtime.runTaskEffect(task.id, publishSpec);
  process.stdout.write(`publish decision after resume: ${outcome.decision}\n`);

  if (outcome.decision !== "executed" || outcome.outcome.status !== "confirmed") {
    process.stdout.write(
      `publish not confirmed (${outcome.decision}${outcome.outcome !== undefined ? `/${outcome.outcome.status}` : ""})\n`,
    );
    return;
  }

  const store = await ArtifactStore.open({ root: ARTIFACTS });
  const receipt = await store.write({
    content: `release receipt\nkey=${RELEASE_KEY}\neffect=${outcome.effectId}\n`,
    mediaType: "text/plain",
    producer: { type: "tool", id: "release-publish" },
    refs: { run: task.id },
  });
  await runtime.linkArtifact(task.id, receipt.artifactId, "generated");

  const epi = await openEpi();
  await epi.putDecision({
    id: `decision-${task.id}`,
    investigationId: `inv-${task.id}`,
    summary: `release ${RELEASE_KEY} approved and published`,
    reason: "high-impact",
    createdAt: Date.now(),
    resolvedAt: Date.now(),
  });
  epi.close();
  await runtime.complete(task.id);
}

/**
 * `relay task` CLI integration: the subcommands are real child processes on
 * a shared .relay/storage.db — the same persistence surface the slice uses.
 * Covers AC-01/02/03's CLI-facing surface plus approve idempotency.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { hashRequest } from "@relay/core";

const cliJs = fileURLToPath(new URL("../src/cli.js", import.meta.url));

let tmp = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-cli-task-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string = tmp) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    cwd,
    env: process.env,
  });
}

describe("relay task", () => {
  it("create -> list -> show -> cancel across separate processes", () => {
    const created = runCli(["task", "create", "ship", "the", "release"]);
    assert.equal(created.status, 0, created.stderr);
    const id = (created.stdout ?? "").trim().split(/\s+/)[0] ?? "";
    assert.match(id, /^[0-9a-f-]{36}$/);

    const listed = runCli(["task", "list"]);
    assert.equal(listed.status, 0);
    assert.ok((listed.stdout ?? "").includes(id));
    assert.ok((listed.stdout ?? "").includes("ACTIVE"));

    const shown = runCli(["task", "show", id]);
    assert.equal(shown.status, 0);
    const snapshot = JSON.parse(shown.stdout ?? "{}") as { schema?: string; status?: string; goal?: string };
    assert.equal(snapshot.schema, "relay.task-snapshot/1");
    assert.equal(snapshot.status, "ACTIVE");
    assert.equal(snapshot.goal, "ship the release");

    const cancelled = runCli(["task", "cancel", id]);
    assert.equal(cancelled.status, 0);
    const shownAfter = runCli(["task", "show", id]);
    assert.match(shownAfter.stdout ?? "", /"CANCELLED"/);
    const resumed = runCli(["task", "resume", id]);
    assert.equal(resumed.status, 2);
    assert.match(resumed.stdout ?? "", /cancelled/);
  });

  it("resume on a nonexistent task reports 66", () => {
    const res = runCli(["task", "resume", "no-such-task"]);
    assert.equal(res.status, 66);
    const shown = runCli(["task", "show", "no-such-task"]);
    assert.equal(shown.status, 66);
  });

  it("task run without an adapter module creates + reports status", () => {
    const res = runCli(["task", "run", "plain", "goal"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout ?? "", /task [0-9a-f-]{36}/);
    assert.match(res.stdout ?? "", /status ACTIVE/);
  });

  it("approve on a task with no pending approvals resolves zero (idempotent)", () => {
    const created = runCli(["task", "create", "idle"]);
    const id = (created.stdout ?? "").trim().split(/\s+/)[0] ?? "";
    const approved = runCli(["task", "approve", id]);
    assert.equal(approved.status, 0);
    assert.match(approved.stdout ?? "", /resolved-awaits 0/);
  });

  it("adapter-module seam loads app code for run", async () => {
    const modPath = join(tmp, "mod.mjs");
    const code = `export async function run({ task }) {
      process.stdout.write("module ran for " + task.id + "\\n");
    }`;
    writeFileSync(modPath, code);
    const res = runCli(["task", "run", "with", "module", "--adapter-module", modPath]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout ?? "", /module ran for [0-9a-f-]{36}/);
  });
});

// ---------------------------------------------------------------------------
// Stage 1 cross-process acceptance (RELAYMUSE_HARDENING_PLAN):
//   - approval bound to kind+requestHash across process boundaries
//   - slow/pending deferred parks durably, adapter not polled behind human gates
//   - unknown publish blocks completion, restart reconciles without re-executing
//   - atomic parking survives a real SIGKILL at the boundary
//   - the reference pi-muse module never completes on a failed publish
// ---------------------------------------------------------------------------

let modCounter = 0;
function writeModule(code: string): string {
  modCounter += 1;
  const path = join(tmp, `stage1-mod-${modCounter}.mjs`);
  writeFileSync(path, code);
  return path;
}

function markerCount(dir: string, name: string): number {
  const path = join(dir, `${name}.count`);
  return existsSync(path) ? readFileSync(path, "utf8").length : 0;
}

function runCliEnv(args: string[], env: Record<string, string>, cwd: string = tmp) {
  return spawnSync(process.execPath, [cliJs, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
}

function runCliAsync(args: string[], env: Record<string, string>, cwd: string) {
  return new Promise<{ status: number | null; signal: string | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, out, err });
    });
  });
}

describe("relay task stage-1 hardening (cross-process)", () => {
  it("approving request A does not authorize a drifted request B; B re-approves then runs once", () => {
    const mark = join(tmp, "mark-drift");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.MARK_DIR;
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); };
function spec() {
  return {
    name: "publish",
    kind: "http/publish",
    request: JSON.parse(process.env.EFFECT_REQUEST_JSON || "{}"),
    approvalRequired: true,
    execute: async () => { bump("remote"); return { remoteRef: "r1" }; },
  };
}
export const adapter = {
  id: "pi",
  resume: async () => { bump("adapter-calls"); return { resumed: true, status: "completed" }; },
};
export async function run({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec());
  process.stdout.write("decision " + o.decision + "\\n");
}
export async function continuation({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec());
  process.stdout.write("decision " + o.decision + "\\n");
  if (o.decision === "executed" && o.outcome.status === "confirmed") {
    await runtime.complete(task.id);
  }
}
`);
    const envA = { MARK_DIR: mark, EFFECT_REQUEST_JSON: '{"v":"a"}' };
    const envB = { MARK_DIR: mark, EFFECT_REQUEST_JSON: '{"v":"b"}' };

    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], envA);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout ?? "", /decision awaiting-approval/);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";
    assert.notEqual(id, "");

    // adapter must not be polled while the human approval is still pending
    const early = runCliEnv(["task", "resume", id, "--adapter-module", modPath], envA);
    assert.equal(early.status, 1);
    assert.match(early.stdout ?? "", /await-pending/);
    assert.equal(markerCount(mark, "adapter-calls"), 0, "adapter.resume must not run behind a pending approval");

    const approve = runCliEnv(["task", "approve", id], envA);
    assert.equal(approve.status, 0);
    // the approved identity (kind + request hash) is printed for inspection
    assert.match(approve.stdout ?? "", /requestHash=[0-9a-f]{12}/);

    // Process restart + module config drift: request B must NOT execute.
    const drift = runCliEnv(["task", "resume", id, "--adapter-module", modPath], envB);
    assert.equal(drift.status, 0);
    assert.match(drift.stdout ?? "", /decision awaiting-approval/);
    assert.equal(markerCount(mark, "remote"), 0, "request B must not execute under A's approval");

    const show = runCliEnv(["task", "show", id], envB);
    const snap = JSON.parse(show.stdout ?? "{}") as {
      status: string;
      waitingFor: { kind: string; binding?: { kind: string; requestHash: string } }[];
    };
    assert.equal(snap.status, "WAITING");
    const bound = snap.waitingFor.find((w) => w.kind === "APPROVAL");
    assert.equal(bound?.binding?.requestHash, hashRequest({ v: "b" }), "the pending wait identifies request B");

    // Approving the B-bound wait resumes and executes exactly once.
    const approve2 = runCliEnv(["task", "approve", id], envB);
    assert.equal(approve2.status, 0);
    const resumed = runCliEnv(["task", "resume", id, "--adapter-module", modPath], envB);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout ?? "", /resumed/);
    assert.equal(markerCount(mark, "remote"), 1, "B executes exactly once after its own approval");
    const done = JSON.parse(runCliEnv(["task", "show", id], envB).stdout ?? "{}") as { status: string };
    assert.equal(done.status, "COMPLETED");
  });

  it("a slow/pending deferred parks durably and resumes without a second agent leg", () => {
    const mark = join(tmp, "mark-slow");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.MARK_DIR;
const count = (n) => { const f = join(dir, n + ".count"); return existsSync(f) ? readFileSync(f, "utf8").length : 0; };
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); return count(n); };
export const adapter = {
  id: "pi",
  resume: async () => {
    const n = bump("adapter-calls");
    return n < 2
      ? { resumed: false, status: "pending", detail: "deferred run still pending" }
      : { resumed: true, status: "completed", output: "done" };
  },
};
export async function run({ task }) { process.stdout.write("ran " + task.id + "\\n"); }
export async function continuation({ runtime, task }) {
  bump("continued");
  await runtime.complete(task.id);
}
`);
    const env = { MARK_DIR: mark };
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], env);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    const first = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
    assert.equal(first.status, 1, `expected waiting, got: ${first.stdout}`);
    assert.match(first.stdout ?? "", /waiting/);
    assert.equal(markerCount(mark, "continued"), 0, "continuation must not run while the agent leg is pending");

    // The parked state survives the process boundary.
    const shown = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as {
      status: string;
      waitingFor: { kind: string; ref?: string }[];
    };
    assert.equal(shown.status, "WAITING");
    const agentWait = shown.waitingFor.find((w) => w.kind === "EXTERNAL");
    assert.equal(agentWait?.ref, "adapter:pi");

    const second = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout ?? "", /resumed/);
    assert.equal(markerCount(mark, "adapter-calls"), 2);
    assert.equal(markerCount(mark, "continued"), 1);
  });

  it("SIGKILL immediately after parking never persists a split ACTIVE+pending state", async () => {
    const modPath = writeModule(`
export async function run({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, {
    name: "publish",
    kind: "http/publish",
    request: { r: 1 },
    approvalRequired: true,
    execute: async () => ({}),
  });
  process.stdout.write("decision " + o.decision + "\\n");
  process.kill(process.pid, "SIGKILL");
}
`);
    const ws = mkdtempSync(join(tmp, "kill-ws-"));
    const child = await runCliAsync(["task", "run", "ship", "--adapter-module", modPath], {}, ws);
    // POSIX reports signal SIGKILL; Windows reports signal null with a non-zero exit.
    const died =
      child.signal === "SIGKILL" ||
      (process.platform === "win32" && child.signal === null && child.status !== 0);
    assert.ok(died, `expected the run process to die: ${child.out}`);
    const taskId = /task ([0-9a-f-]{36})/.exec(child.out)?.[1] ?? "";
    const snap = JSON.parse(runCliEnv(["task", "show", taskId], {}, ws).stdout ?? "{}") as {
      status: string;
      waitingFor: unknown[];
    };
    // Reopen must never expose "await committed but task still ACTIVE".
    assert.equal(snap.status, "WAITING");
    assert.equal(snap.waitingFor.length, 1);
  });

  it("an UNKNOWN publish blocks completion; restart reconciles without re-executing", () => {
    const mark = join(tmp, "mark-unknown");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const { AmbiguousEffectError } = await import(process.env.RELAY_CORE_URL);
const dir = process.env.MARK_DIR;
const count = (n) => { const f = join(dir, n + ".count"); return existsSync(f) ? readFileSync(f, "utf8").length : 0; };
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); return count(n); };
const spec = {
  name: "publish",
  kind: "http/publish",
  request: { r: 1 },
  approvalRequired: false,
  execute: async () => {
    bump("remote");
    if (process.env.THROW_AMBIG === "1") throw new AmbiguousEffectError("lost the response");
    return { remoteRef: "r1" };
  },
  reconcile: async () => {
    bump("reconcile");
    return process.env.RECONCILE_FOUND === "1"
      ? { found: true, remoteRef: "r1", result: { ok: true } }
      : { found: "uncertain", reason: "remote unreachable" };
  },
};
export const effects = [spec];
export async function run({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  process.stdout.write("decision " + o.decision + " " + (o.outcome ? o.outcome.status : "") + "\\n");
}
export async function continuation({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  process.stdout.write("decision " + o.decision + " " + (o.outcome ? o.outcome.status : "") + "\\n");
  if (o.decision === "executed" && o.outcome.status === "confirmed") {
    bump("receipt");
    await runtime.complete(task.id);
  } else {
    process.stdout.write("publish not confirmed\\n");
  }
}
`);
    const coreUrl = pathToFileURL(fileURLToPath(new URL("../../../core/dist/src/index.js", import.meta.url))).href;
    const envAmbig = { MARK_DIR: mark, RELAY_CORE_URL: coreUrl, THROW_AMBIG: "1" };
    const envNo = { MARK_DIR: mark, RELAY_CORE_URL: coreUrl, RECONCILE_FOUND: "0" };
    const envYes = { MARK_DIR: mark, RELAY_CORE_URL: coreUrl, RECONCILE_FOUND: "1" };

    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], envAmbig);
    assert.match(run.stdout ?? "", /decision executed unknown/);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    // Resume with an uncertain reconcile: stays UNKNOWN, no completion.
    const stuck = runCliEnv(["task", "resume", id, "--adapter-module", modPath], envNo);
    assert.equal(stuck.status, 1, `expected waiting: ${stuck.stdout}`);
    assert.equal(markerCount(mark, "remote"), 1, "reconcile must never re-execute");
    assert.equal(markerCount(mark, "receipt"), 0, "no success receipt for an unknown effect");
    const mid = JSON.parse(runCliEnv(["task", "show", id], envNo).stdout ?? "{}") as { status: string };
    assert.notEqual(mid.status, "COMPLETED");

    // Restart with a decisive reconcile: confirms remotely, then completes.
    const healed = runCliEnv(["task", "resume", id, "--adapter-module", modPath], envYes);
    assert.equal(healed.status, 0, healed.stderr);
    assert.equal(markerCount(mark, "remote"), 1);
    assert.equal(markerCount(mark, "receipt"), 1);
    const done = JSON.parse(runCliEnv(["task", "show", id], envYes).stdout ?? "{}") as { status: string };
    assert.equal(done.status, "COMPLETED");
  });

  it("a continuation that hits UNKNOWN cannot complete the task", () => {
    const mark = join(tmp, "mark-nocomplete");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const { AmbiguousEffectError } = await import(process.env.RELAY_CORE_URL);
const dir = process.env.MARK_DIR;
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); };
const spec = {
  name: "publish",
  kind: "http/publish",
  request: { r: 1 },
  approvalRequired: false,
  execute: async () => {
    bump("remote");
    throw new AmbiguousEffectError("lost the response");
  },
  reconcile: async () => ({ found: "uncertain", reason: "remote unreachable" }),
};
export const effects = [spec];
export async function run({ task }) { process.stdout.write("ran " + task.id + "\\n"); }
export async function continuation({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  process.stdout.write("decision " + o.decision + " " + (o.outcome ? o.outcome.status : "") + "\\n");
  if (o.decision === "executed" && o.outcome.status === "confirmed") {
    await runtime.complete(task.id);
    return;
  }
  try {
    await runtime.complete(task.id);
    process.stdout.write("complete accepted\\n");
  } catch (err) {
    process.stdout.write("complete refused: " + String(err && err.message || err) + "\\n");
  }
}
`);
    const coreUrl = pathToFileURL(fileURLToPath(new URL("../../../core/dist/src/index.js", import.meta.url))).href;
    const env = { MARK_DIR: mark, RELAY_CORE_URL: coreUrl };
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], env);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    const resumed = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
    assert.match(
      resumed.stdout ?? "",
      /complete refused/,
      `expected refusal. run.out=${run.stdout ?? ""} run.err=${run.stderr ?? ""} id=${id} resume.out=${resumed.stdout ?? ""} resume.err=${resumed.stderr ?? ""}`,
    );
    const snap = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as { status: string };
    assert.notEqual(snap.status, "COMPLETED", "an UNKNOWN effect must not be marked complete");
  });

  it("pi-muse module: a FAILED publish writes no success receipt and never completes", { timeout: 300_000 }, async () => {
    const { startReleaseServer } = (await import(
      new URL("../../../../examples/pi-muse/fixtures/release-server.mjs", import.meta.url).href
    )) as { startReleaseServer: (ms?: number) => Promise<{ baseUrl: string; state: () => Promise<{ publishRequests: number; mutations: number }>; stop: () => Promise<void> }> };
    const runtimePath = fileURLToPath(new URL("../../../../examples/pi-muse/pi-muse-runtime.mjs", import.meta.url));
    const server = await startReleaseServer(50);
    const ws = mkdtempSync(join(tmp, "pi-muse-ws-"));
    const env = {
      MUSE_SERVER_URL: server.baseUrl,
      MUSE_SESSION_DIR: join(ws, ".relay", "sessions"),
      MUSE_RELEASE_KEY: "fail-1",
    };
    try {
      const run = await runCliAsync(["task", "run", "release fail-1", "--adapter-module", runtimePath], env, ws);
      assert.equal(run.status, 0, run.err || run.out);
      assert.match(run.out, /publish decision: awaiting-approval/);
      const id = /task ([0-9a-f-]{36})/.exec(run.out)?.[1] ?? "";

      const approve = await runCliAsync(["task", "approve", id], env, ws);
      assert.equal(approve.status, 0, approve.err);

      const resumed = await runCliAsync(["task", "resume", id, "--adapter-module", runtimePath], env, ws);
      assert.equal(resumed.status, 0, resumed.err || resumed.out);
      assert.match(resumed.out, /publish not confirmed/);

      const show = await runCliAsync(["task", "show", id], env, ws);
      const snap = JSON.parse(show.out) as {
        status: string;
        artifacts: unknown[];
        investigation?: { decisions: unknown[] };
      };
      assert.notEqual(snap.status, "COMPLETED", "a failed publish must never complete the task");
      assert.equal(snap.artifacts.length, 1, "no success receipt artifact was written");
      assert.equal(snap.investigation?.decisions.length ?? 0, 0, "no success decision was recorded");

      const state = await server.state();
      assert.equal(state.mutations, 0);
    } finally {
      await server.stop();
    }
  });

  it("pending -> pending -> completed re-polls the adapter and keeps exactly one adapter wait", () => {
    const mark = join(tmp, "mark-pending-pending");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.MARK_DIR;
const count = (n) => { const f = join(dir, n + ".count"); return existsSync(f) ? readFileSync(f, "utf8").length : 0; };
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); return count(n); };
export const adapter = {
  id: "pi",
  resume: async () => {
    const n = bump("polls");
    return n < 3
      ? { resumed: false, status: "pending", detail: "deferred run still pending" }
      : { resumed: true, status: "completed", output: "done" };
  },
};
export async function run({ task }) { process.stdout.write("ran " + task.id + "\\n"); }
export async function continuation({ task }) {
  bump("continued");
  process.stdout.write("continued " + task.id + "\\n");
}
`);
    const env = { MARK_DIR: mark };
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], env);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    for (const n of [1, 2]) {
      const r = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
      assert.equal(r.status, 1, `resume ${n} must wait: ${r.stdout}`);
      assert.match(r.stdout ?? "", /waiting/);
    }
    // Each resume is a fresh process on the same storage.db: still one wait.
    const shown = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as {
      waitingFor: { kind: string; ref?: string }[];
    };
    assert.equal(
      shown.waitingFor.filter((w) => w.kind === "EXTERNAL").length,
      1,
      "repeated pending must park exactly one adapter-owned wait",
    );
    assert.equal(markerCount(mark, "polls"), 2, "the adapter is re-polled, not blocked on its own wait");

    const third = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(markerCount(mark, "polls"), 3);
    assert.equal(markerCount(mark, "continued"), 1, "continuation runs exactly once");
    const done = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as {
      waitingFor: unknown[];
    };
    assert.equal(done.waitingFor.length, 0, "the adapter wait clears on completion");
  });

  it("failed -> failed -> completed re-polls the adapter and keeps exactly one adapter wait", () => {
    const mark = join(tmp, "mark-failed-failed");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.MARK_DIR;
const count = (n) => { const f = join(dir, n + ".count"); return existsSync(f) ? readFileSync(f, "utf8").length : 0; };
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); return count(n); };
export const adapter = {
  id: "pi",
  resume: async () => {
    const n = bump("polls");
    return n < 3
      ? { resumed: false, status: "failed", detail: "transport error" }
      : { resumed: true, status: "completed", output: "done" };
  },
};
export async function run({ task }) { process.stdout.write("ran " + task.id + "\\n"); }
export async function continuation({ task }) {
  bump("continued");
  process.stdout.write("continued " + task.id + "\\n");
}
`);
    const env = { MARK_DIR: mark };
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], env);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    for (const n of [1, 2]) {
      const r = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
      assert.notEqual(r.status, 0, `resume ${n} must block: ${r.stdout}`);
      assert.match(r.stdout ?? "", /blocked/);
    }
    const shown = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as {
      waitingFor: { kind: string; ref?: string }[];
    };
    assert.equal(shown.waitingFor.filter((w) => w.kind === "EXTERNAL").length, 1);
    assert.equal(markerCount(mark, "polls"), 2);

    const third = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(markerCount(mark, "polls"), 3);
    assert.equal(markerCount(mark, "continued"), 1);
  });

  it("duplicate adapter-owned waits collapse on resume; an app EXTERNAL wait stays pending", () => {
    const modPath = writeModule(`
export async function run({ runtime, task }) {
  // Simulate a previous build that parked two adapter waits plus an app wait.
  await runtime.createAwait(task.id, { kind: "EXTERNAL", reason: "stale adapter wait", ref: "adapter:pi" });
  await runtime.createAwait(task.id, { kind: "EXTERNAL", reason: "stale adapter wait 2", ref: "adapter:pi" });
  await runtime.createAwait(task.id, { kind: "EXTERNAL", reason: "app webhook wait", ref: "app:webhook" });
}
export const adapter = {
  id: "pi",
  resume: async () => ({ resumed: true, status: "completed" }),
};
export async function continuation() {}
`);
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], {});
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    const resumed = runCliEnv(["task", "resume", id, "--adapter-module", modPath], {});
    assert.equal(resumed.status, 1, resumed.stdout ?? "");
    assert.match(resumed.stdout ?? "", /await-pending|blocked/, "the app wait still gates");
    const shown = JSON.parse(runCliEnv(["task", "show", id], {}).stdout ?? "{}") as {
      waitingFor: { kind: string; ref?: string }[];
    };
    assert.deepEqual(
      shown.waitingFor.map((w) => w.ref),
      ["adapter:pi", "app:webhook"],
      "adapter-owned duplicates collapse to one; the app wait is never auto-resolved",
    );
  });

  it("a FAILED effect refuses completion across process restarts and is never re-executed", () => {
    const mark = join(tmp, "mark-fail-refuse");
    mkdirSync(mark, { recursive: true });
    const modPath = writeModule(`
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.MARK_DIR;
const bump = (n) => { appendFileSync(join(dir, n + ".count"), "x"); };
const spec = {
  name: "publish",
  kind: "http/publish",
  request: { r: 1 },
  approvalRequired: false,
  execute: async () => {
    bump("remote");
    throw new Error("remote rejected");
  },
};
export const effects = [spec];
export async function run({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  process.stdout.write("decision " + o.decision + " " + (o.outcome ? o.outcome.status : "") + "\\n");
}
export async function continuation({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  process.stdout.write("decision " + o.decision + " " + (o.outcome ? o.outcome.status : "") + "\\n");
  try {
    await runtime.complete(task.id);
    process.stdout.write("complete accepted\\n");
  } catch (err) {
    process.stdout.write("complete refused: " + String(err && err.message || err) + "\\n");
  }
}
`);
    const env = { MARK_DIR: mark };
    const run = runCliEnv(["task", "run", "ship", "--adapter-module", modPath], env);
    assert.match(run.stdout ?? "", /decision executed failed/);
    const id = /task ([0-9a-f-]{36})/.exec(run.stdout ?? "")?.[1] ?? "";

    for (const n of [1, 2]) {
      // Each resume is a separate process on the same storage.db (close/reopen).
      const r = runCliEnv(["task", "resume", id, "--adapter-module", modPath], env);
      assert.match(
        r.stdout ?? "",
        /complete refused/,
        `resume ${n}: FAILED must refuse completion. out=${r.stdout} err=${r.stderr}`,
      );
      assert.doesNotMatch(r.stdout ?? "", /complete accepted/);
    }
    assert.equal(markerCount(mark, "remote"), 1, "FAILED is terminal; never blindly re-executed");
    const shown = JSON.parse(runCliEnv(["task", "show", id], env).stdout ?? "{}") as { status: string };
    assert.notEqual(shown.status, "COMPLETED");
  });

  it("crash AFTER remote commit reconciles without re-POSTing (POST=1)", { timeout: 300_000 }, async () => {
    const { startReleaseServer } = (await import(
      new URL("../../../../examples/pi-muse/fixtures/release-server.mjs", import.meta.url).href
    )) as { startReleaseServer: (ms?: number) => Promise<{ baseUrl: string; state: () => Promise<{ publishRequests: number; mutations: number }>; stop: () => Promise<void> }> };
    const server = await startReleaseServer(50);
    const ws = mkdtempSync(join(tmp, "crash-ws-"));
    const modPath = writeModule(`
const spec = {
  name: "publish",
  kind: "http/publish",
  request: { key: "k1" },
  approvalRequired: false,
  execute: async () => {
    const res = await fetch(process.env.MUSE_SERVER_URL + "/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "k1" }),
    });
    if (!res.ok) throw new Error("publish failed " + res.status);
    // Remote committed; the journal only holds SUBMITTED when we die here.
    process.kill(process.pid, "SIGKILL");
  },
  reconcile: async () => {
    const res = await fetch(process.env.MUSE_SERVER_URL + "/effects/k1");
    if (!res.ok) return { found: "uncertain", reason: "remote unreachable" };
    const body = await res.json();
    return { found: true, remoteRef: body.remoteRef, result: body };
  },
};
export const effects = [spec];
export async function run({ runtime, task }) {
  await runtime.runTaskEffect(task.id, spec);
}
export async function continuation({ runtime, task }) {
  const o = await runtime.runTaskEffect(task.id, spec);
  if (o.decision === "executed" && o.outcome && o.outcome.status === "confirmed") {
    process.stdout.write("publish confirmed; completing\\n");
    await runtime.complete(task.id);
  } else {
    process.stdout.write("publish not confirmed\\n");
  }
}
`);
    const env = { MUSE_SERVER_URL: server.baseUrl };
    try {
      const run = await runCliAsync(["task", "run", "ship", "--adapter-module", modPath], env, ws);
      const died =
        run.signal === "SIGKILL" ||
        (process.platform === "win32" && run.signal === null && run.status !== 0);
      assert.ok(died, `expected the run process to die after remote commit: ${run.out}`);
      const id = /task ([0-9a-f-]{36})/.exec(run.out)?.[1] ?? "";
      const committed = await server.state();
      assert.equal(committed.publishRequests, 1, "the remote commit landed before the crash");
      assert.equal(committed.mutations, 1);

      // Fresh process on the same storage.db: reconcile must be read-only.
      const resumed = await runCliAsync(["task", "resume", id, "--adapter-module", modPath], env, ws);
      assert.equal(resumed.status, 0, resumed.err || resumed.out);
      assert.match(resumed.out, /publish confirmed/);

      const after = await server.state();
      assert.equal(after.publishRequests, 1, "reconciliation is read-only — never a second POST");
      assert.equal(after.mutations, 1);
      const shown = await runCliAsync(["task", "show", id], env, ws);
      assert.equal((JSON.parse(shown.out) as { status: string }).status, "COMPLETED");
    } finally {
      await server.stop();
    }
  });
});


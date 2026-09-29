#!/usr/bin/env node
/**
 * pi-muse vertical slice — the Muse-style durable personal-agent demo on
 * top of Relay v0.2.
 *
 * "Release Assistant" slice, end to end across REAL process kills:
 *   task run -> WAIT (approval) -> process exits -> restart -> still WAITING
 *   -> approve -> resume -> Pi deferred job completes -> publish executes
 *   exactly once -> COMPLETED. A second task is SIGKILLed after the remote
 *   publish commits and recovers by reconciliation — never a blind retry.
 *
 * Every `relay task ...` step below is a separate child process against the
 * same workspace directory; nothing survives a process boundary except the
 * durable state in .relay/.
 *
 * Usage: node examples/pi-muse/demo.mjs
 * Requires: pnpm install && pnpm -r build (or `pnpm check`) have run.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReleaseServer } from "./fixtures/release-server.mjs";

const ARTIFACT = new URL("../../packages/artifact-fs/dist/src/index.js", import.meta.url).href;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = fileURLToPath(new URL("../../packages/cli/dist/src/cli.js", import.meta.url));
const RUNTIME = join(HERE, "pi-muse-runtime.mjs");

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

function relay(args, { cwd, env = {}, name = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    // stdout and stderr stay separate: machine-readable output lives on
    // stdout; diagnostics/warnings on stderr never corrupt JSON parsing.
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, out, err });
    });
    void name;
  });
}

// Real process death, portable: POSIX reports signal SIGKILL; Windows
// reports signal null with a non-zero exit.
function wasKilled(res) {
  return (
    res.signal === "SIGKILL" ||
    (process.platform === "win32" && res.signal === null && res.status !== 0)
  );
}

async function show(cwd, id) {
  const res = await relay(["task", "show", id], { cwd });
  if (res.status !== 0) throw new Error(`task show failed:\n${res.out}\n${res.err}`);
  return JSON.parse(res.out);
}

async function orchestrate() {
  const server = await startReleaseServer(600);
  const ws = mkdtempSync(join(tmpdir(), "relay-pi-muse-"));
  const env = { MUSE_SERVER_URL: server.baseUrl, MUSE_SESSION_DIR: join(ws, ".relay", "sessions") };
  const log = (s) => console.log(`\n=== ${s} ===`);

  try {
    log(`release server ${server.baseUrl}; workspace ${ws}`);

    // ---------------- task 1: run -> wait -> approve -> resume -> complete
    log("RUN — create + attach agent + evidence + gated publish");
    const run1 = await relay(
      ["task", "run", "--agent", "pi", "--adapter-module", RUNTIME, "release pkg-1"],
      { cwd: ws, env },
    );
    console.log(run1.out.trim());
    const taskId = /task ([0-9a-f-]{36})/.exec(run1.out)?.[1];
    check("run created a task", taskId !== undefined, run1.err);
    check("publish gated on approval (ASK, not executed)", run1.out.includes("publish decision: awaiting-approval"), run1.err);
    check("task parked WAITING", run1.out.includes("status WAITING"), run1.err);

    log("RESTART — a fresh process must still know the task");
    const list = await relay(["task", "list"], { cwd: ws });
    check("task survives restart (list)", list.status === 0 && list.out.includes(taskId) && list.out.includes("WAITING"));
    const snapWait = await show(ws, taskId);
    check("snapshot derives the pending APPROVAL wait", snapWait.waitingFor?.[0]?.kind === "APPROVAL");
    const waitRoles = (snapWait.artifacts ?? []).map((a) => a.role);
    check("package manifest + real test evidence linked at run time",
      waitRoles.includes("input") && waitRoles.includes("evidence"));

    log("RESUME before approval — must be blocked, remote untouched");
    const early = await relay(["task", "resume", taskId, "--adapter-module", RUNTIME], { cwd: ws, env });
    console.log(early.out.trim());
    check("premature resume blocked (await-pending)", early.out.includes("await-pending"));
    check("remote mutations still 0", (await server.state()).mutations === 0);

    log("APPROVE — twice: the second is a no-op");
    const ok1 = await relay(["task", "approve", taskId], { cwd: ws });
    const ok2 = await relay(["task", "approve", taskId], { cwd: ws });
    check("first approve resolved the wait", ok1.out.includes("resolved-awaits 1"));
    check("second approve is a no-op", ok2.out.includes("resolved-awaits 0"));

    log("RESUME — doctor-shaped gate, then Pi resume, then the effect once");
    const resumed1 = await relay(["task", "resume", taskId, "--adapter-module", RUNTIME], { cwd: ws, env });
    console.log(resumed1.out.trim());
    check("resume gate passed", resumed1.out.includes(`resumed ${taskId}`));
    check("deferred agent run completed", resumed1.out.includes("deferred run completed"));
    let state = await server.state();
    check("remote publish mutations for pkg-1 == 1", state.mutations === 1 && state.publishedKeys.includes("release-pkg-1"));
    check("remote publish REQUESTS == 1 (no retry)", state.publishRequests === 1);

    log("DOUBLE RESUME — terminal task must not re-execute");
    const resumed2 = await relay(["task", "resume", taskId, "--adapter-module", RUNTIME], { cwd: ws, env });
    check("second resume reports already-complete", resumed2.out.includes("completed") && resumed2.out.includes("already"));
    state = await server.state();
    check("remote mutations still 1 after double resume", state.mutations === 1);

    const snapDone = await show(ws, taskId);
    check("snapshot: status COMPLETED", snapDone.status === "COMPLETED");
    check("snapshot: confirmed effects includes publish", (snapDone.confirmed ?? []).includes("publish"));

    // Real lineage: package manifest -> test evidence -> publish receipt,
    // verified through the artifact store's parent graph (not a count).
    const { ArtifactStore } = await import(ARTIFACT);
    const artifactStore = await ArtifactStore.open({ root: join(ws, ".relay", "artifacts") });
    const byRole = {};
    for (const link of snapDone.artifacts ?? []) {
      byRole[link.role] = await artifactStore.resolve(link.artifactId);
    }
    check("package manifest artifact linked as input", byRole.input !== undefined);
    check("test evidence is a child of the package manifest",
      byRole.evidence !== undefined &&
        byRole.input !== undefined &&
        byRole.evidence.parents.includes(byRole.input.id));
    const evidenceContent =
      byRole.evidence === undefined ? "" : (await artifactStore.content(byRole.evidence)).toString("utf8");
    check("readiness evidence records real command + exit code",
      evidenceContent.includes("exitCode=0") && evidenceContent.includes("command="));
    check("publish receipt is a child of the test evidence",
      byRole.generated !== undefined &&
        byRole.evidence !== undefined &&
        byRole.generated.parents.includes(byRole.evidence.id));
    const lineage = byRole.generated === undefined
      ? { problems: ["no receipt"], root: undefined }
      : await artifactStore.lineage(byRole.generated.id);
    check("receipt lineage walks receipt->evidence->package without problems",
      lineage.problems.length === 0 &&
        lineage.root !== undefined &&
        lineage.root.parents.length === 1 &&
        lineage.root.parents[0].parents.length === 1 &&
        byRole.input !== undefined &&
        lineage.root.parents[0].parents[0].record.id === byRole.input.id);
    check("artifact store integrity clean", (await artifactStore.verify()).problems.length === 0);
    check("snapshot: investigation linked + claims derived", typeof snapDone.investigationId === "string" && (snapDone.investigation?.claims ?? []).length > 0);
    check("snapshot: no unresolved effects", (snapDone.unresolvedEffects ?? []).length === 0);

    const ev1 = await relay(["task", "events", taskId], { cwd: ws });
    check("event chain has the full lifecycle",
      ["TASK_CREATED", "AGENT_ATTACHED", "WAIT_CREATED", "WAIT_RESOLVED", "TASK_RESUMED", "EFFECT_PREPARED", "EFFECT_CONFIRMED", "TASK_COMPLETED"]
        .every((t) => ev1.out.includes(t)));

    // ---------------- task 2: crash AFTER the remote commit ----------------
    log("TASK 2 — SIGKILL after the remote publish commits");
    const env2 = { ...env, MUSE_RELEASE_KEY: "release-pkg-2" };
    const run2 = await relay(
      ["task", "run", "--agent", "pi", "--adapter-module", RUNTIME, "release pkg-2"],
      { cwd: ws, env: env2 },
    );
    const task2 = /task ([0-9a-f-]{36})/.exec(run2.out)?.[1];
    check("task 2 created + parked", task2 !== undefined && run2.out.includes("status WAITING"));
    await relay(["task", "approve", task2], { cwd: ws });

    // Crash evidence = real death + kill-intent marker at the crash point +
    // no after-kill marker + remote committed. A plain non-zero exit cannot
    // satisfy it. The negative leg runs BEFORE the crash leg so no kill
    // marker exists yet (required on win32 where wasKilled is ambiguous).
    const KILL_INTENT = join(ws, ".relay", "kill-intent");
    const AFTER_KILL = join(ws, ".relay", "after-kill");
    const killedEvidence = (res, committed) =>
      wasKilled(res) && existsSync(KILL_INTENT) && !existsSync(AFTER_KILL) && committed;
    const notKilled = await relay(["task", "resume", "00000000-0000-0000-0000-000000000000"], { cwd: ws, env: env2 });
    check("a plain non-zero exit is not crash evidence",
      notKilled.status !== 0 && !killedEvidence(notKilled, true),
      `status=${notKilled.status} signal=${notKilled.signal}`);

    const killed = await relay(["task", "resume", task2, "--adapter-module", RUNTIME], {
      cwd: ws,
      env: { ...env2, MUSE_CRASH_AFTER_PUBLISH: "1" },
    });
    check("resume process really died (SIGKILL / non-zero)", wasKilled(killed), `signal=${killed.signal} status=${killed.status}`);
    state = await server.state();
    check("remote committed the publish for pkg-2", state.publishedKeys.includes("release-pkg-2"));
    check("publish REQUESTS == 2 total (one per task)", state.publishRequests === 2);

    check("crash evidence: killed at the commit point (intent marker, no after-kill, remote committed)",
      killedEvidence(killed, state.publishedKeys.includes("release-pkg-2")));

    const snapCrash = await show(ws, task2);
    check("journal still holds the unsettled effect", (snapCrash.unresolvedEffects ?? []).length >= 1);

    log("RESUME after crash — reconcile, never re-POST");
    const recovered = await relay(["task", "resume", task2, "--adapter-module", RUNTIME], { cwd: ws, env: env2 });
    console.log(recovered.out.trim());
    check("resume after crash succeeded", recovered.out.includes(`resumed ${task2}`));
    state = await server.state();
    check("pkg-2 mutation count == 1 (no duplicate publish)", state.mutations === 2);
    check("publish REQUESTS still 2 — reconciliation never re-POSTed", state.publishRequests === 2);
    const snap2 = await show(ws, task2);
    check("task 2 COMPLETED after reconciliation", snap2.status === "COMPLETED");

    log("EVIDENCE — doctor + journal inspection + artifacts on disk");
    const doctor = await relay(["doctor"], {
      cwd: ws,
      env: {
        PATH: `${join(HERE, "../../packages/adapter-pi/node_modules/.bin")}${delimiter}${process.env.PATH}`,
      },
    });
    check("doctor reaches READY or DEGRADED", doctor.status === 0 || doctor.status === 1, doctor.out.trim().split("\n").at(-1));
    const hist = await relay(["effects", "--history", "--key", `task/${taskId}/publish`], { cwd: ws });
    check("journal history shows prepare->submit->confirm", hist.out.includes("PREPARED") && hist.out.includes("CONFIRMED"));
    const artifactDir = join(ws, ".relay", "artifacts");
    check("artifact files persisted on disk", existsSync(artifactDir) && readdirSync(artifactDir).length > 0);

    state = await server.state();
    console.log(`\n=== REMOTE STATE ===\n${JSON.stringify(state)}`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== ${failed.length === 0 ? "SLICE PASS" : "SLICE FAIL"} — ${results.length - failed.length}/${results.length} checks ===`);
    for (const f of failed) console.error(`FAIL  ${f.label}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await server.stop();
    rmSync(ws, { recursive: true, force: true });
  }
}

await orchestrate();

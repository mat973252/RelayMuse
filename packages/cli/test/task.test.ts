/**
 * `relay task` CLI integration: the subcommands are real child processes on
 * a shared .relay/storage.db — the same persistence surface the slice uses.
 * Covers AC-01/02/03's CLI-facing surface plus approve idempotency.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

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

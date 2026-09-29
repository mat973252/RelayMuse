#!/usr/bin/env node
/**
 * @relay/cli — operator commands.
 *
 * M0: `relay doctor` — capability probes with machine-checkable exit status.
 * M2: `relay artifacts` / `relay lineage <ref>` — artifact registry views.
 *
 * Exit codes: 0 ok | 1 degraded (warn) | 2 blocked (fail) | 64 usage |
 * 66 unknown artifact reference.
 *
 * The CLI never reads or prints arbitrary environment values.
 */
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RELAY_VERSION,
  activationExitCode,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorProbeSpec,
  type ProbeOutcome,
} from "@relay/core";
import { probeSqliteStorage } from "@relay/storage-sqlite";
import { ArtifactStore, probeArtifactRoot, type ArtifactRecord, type LineageNode } from "@relay/artifact-fs";
import { evaluateCapabilitiesFile } from "./capabilities.js";
import { exportCapsule, importCapsule } from "./capsule.js";
import { SqliteEffectJournal, SqliteEffectJournalReader } from "@relay/storage-sqlite";
import { buildStatusDocument } from "./status.js";
import { explainEffects } from "./effect-guidance.js";
import { runTaskCommand } from "./task.js";

const USAGE = `relay — durable execution continuity for AI agents (M2)

usage:
  relay doctor [--json] [--storage PATH] [--artifacts PATH] [--capabilities PATH]
  relay artifacts [--json] [--artifacts PATH]
  relay lineage <artifact-ref> [--json] [--artifacts PATH]
  relay effects [--json] [--storage PATH]
  relay effects --history [--key KEY] [--json] [--storage PATH]
  relay effects --explain [--key KEY] [--storage PATH]
  relay export [--output PATH] [--capabilities PATH] [--adapter-context PATH]
               [--workspace PATH]
  relay import <capsule> [--workspace PATH] [--overwrite]
  relay status [--storage PATH] [--output PATH]
  relay task create <goal...> [--adapter ID] [--storage PATH] [--json]
  relay task run <goal...> [--agent pi] [--adapter-module PATH] [--storage PATH]
  relay task list [--storage PATH] [--json]
  relay task show <task-id> [--storage PATH]
  relay task events <task-id> [--storage PATH] [--json]
  relay task approve <task-id> [--ref NAME] [--storage PATH]
  relay task resume <task-id> [--adapter-module PATH] [--storage PATH]
  relay task cancel <task-id> [--storage PATH]
  relay --help

<artifact-ref> accepts a record id, a sha256 digest, or artifact://sha256/<digest>

doctor also evaluates the capability contract: --capabilities PATH wins,
else the contract imported with .relay (.relay/relay.capabilities.yaml),
else ./relay.capabilities.yaml. Import never touches the root copy.

doctor exit codes:
  0 ok/READY  |  1 degraded/DEGRADED  |  2 blocked/BLOCKED  |  64 usage error

status emits a mat-console.status/1 JSON document from a read-only open of the
effect journal (no directory/DB creation, no schema migration, no pragma
writes). With --output the document is written to PATH; otherwise to stdout.
exit codes: 0 journal sampled | 1 journal unavailable (document still emitted)
| 2 output write failed or refused (--output must never be the journal or
its -wal/-shm/-journal sidecars) | 64 usage error
`;

interface DoctorArgs {
  json: boolean;
  storage: string;
  artifacts: string;
  capabilities: string | undefined;
}

function usageError(message: string): never {
  process.stderr.write(`relay: ${message}\n${USAGE}`);
  process.exit(64);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    usageError(`${flag} requires a value`);
  }
  return value;
}

function parseDoctorArgs(argv: string[], cwd: string): DoctorArgs {
  let json = false;
  let storage: string | undefined;
  let artifacts: string | undefined;
  let capabilities: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--storage") {
      storage = requireValue(argv, i + 1, "--storage");
      i += 1;
    } else if (arg === "--artifacts") {
      artifacts = requireValue(argv, i + 1, "--artifacts");
      i += 1;
    } else if (arg === "--capabilities") {
      capabilities = requireValue(argv, i + 1, "--capabilities");
      i += 1;
    } else {
      usageError(`unknown argument for doctor: ${arg}`);
    }
  }
  return {
    json,
    storage: storage ?? join(cwd, ".relay", "storage.db"),
    artifacts: artifacts ?? join(cwd, ".relay", "artifacts"),
    capabilities,
  };
}

function probePiCli(): ProbeOutcome {
  const result = spawnSync("pi", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error !== undefined || result.status !== 0) {
    return { status: "fail", detail: "pi CLI not available on PATH (pi --version failed)" };
  }
  const version = (result.stdout ?? "").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return { status: "fail", detail: `unexpected pi --version output: ${JSON.stringify(version)}` };
  }
  return { status: "ok", detail: `pi ${version} on PATH` };
}

interface ParsedFlags {
  json: boolean;
  artifacts: string;
  positional: string[];
}

function parseArtifactFlags(argv: string[], cwd: string): ParsedFlags {
  let json = false;
  let artifacts: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--artifacts") {
      artifacts = requireValue(argv, i + 1, "--artifacts");
      i += 1;
    } else if (arg.startsWith("--")) {
      usageError(`unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { json, artifacts: artifacts ?? join(cwd, ".relay", "artifacts"), positional };
}

function renderArtifactLine(record: ArtifactRecord): string {
  const parents = record.parents.length > 0 ? ` parents=${record.parents.length}` : "";
  return `${record.artifactId}  ${record.mediaType}  ${record.byteSize}B  ${record.producer.type}/${record.producer.id}${parents}  ${record.id}`;
}

function renderLineageTree(node: LineageNode, depth = 0): string {
  const indent = "  ".repeat(depth);
  const parentCount = node.parents.length;
  const suffix = depth === 0 ? "" : parentCount > 0 ? " ─┐" : "";
  const lines = [`${indent}${node.record.artifactId}  ${node.record.mediaType}  ${node.record.producer.type}/${node.record.producer.id}${suffix}`];
  for (const parent of node.parents) {
    lines.push(renderLineageTree(parent, depth + 1));
  }
  return lines.join("\n");
}

async function runArtifactsCommand(rest: string[], cwd: string): Promise<number> {
  const args = parseArtifactFlags(rest, cwd);
  if (args.positional.length > 0) usageError(`unexpected argument: ${args.positional[0]}`);
  const store = await ArtifactStore.open({ root: args.artifacts });
  const records = await store.list();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ schema: "relay.artifacts/1", artifacts: records })}\n`);
  } else {
    const lines = records.map(renderArtifactLine);
    process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "(no artifacts)\n");
  }
  return 0;
}

async function runEffectsCommand(rest: string[], cwd: string): Promise<number> {
  let json = false;
  let history = false;
  let explain = false;
  let key: string | undefined;
  let storage: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--json") json = true;
    else if (arg === "--history") history = true;
    else if (arg === "--explain") explain = true;
    else if (arg === "--key") {
      key = requireValue(rest, i + 1, "--key");
      i += 1;
    } else if (arg === "--storage") {
      storage = requireValue(rest, i + 1, "--storage");
      i += 1;
    } else usageError(`unknown argument for effects: ${arg}`);
  }
  if (key !== undefined && !history && !explain) usageError("--key requires --history or --explain");
  if (explain && (json || history)) usageError("--explain cannot be combined with --json or --history");
  if (explain) {
    try {
      const reader = await SqliteEffectJournalReader.open({ path: storage ?? join(cwd, ".relay", "storage.db") });
      try {
        const { histories, malformedRows } = await reader.readJournal(key);
        process.stdout.write(explainEffects(histories, malformedRows));
        return malformedRows > 0 || (key !== undefined && histories.length === 0) ? 1 : 0;
      } finally { reader.close(); }
    } catch (err) {
      process.stderr.write(`relay: cannot explain journal: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  const journal = await SqliteEffectJournal.open({ path: storage ?? join(cwd, ".relay", "storage.db") });
  try {
    if (history) {
      // Read-only. `record` is the latest-state snapshot (execution authority);
      // `events` are the observed committed transitions; `coverage` says
      // whether that history is complete, partial, or unavailable (legacy).
      const histories = await journal.listHistory(key);
      if (json) {
        process.stdout.write(`${JSON.stringify({ schema: "relay.effect-history/1", histories })}\n`);
      } else if (histories.length === 0) {
        process.stdout.write("(no effects)\n");
      } else {
        for (const h of histories) {
          process.stdout.write(`${h.record.status.padEnd(9)} ${h.record.key}  ${h.record.id}  history=${h.coverage}\n`);
          for (const e of h.events) {
            process.stdout.write(`  #${String(e.seq)} ${e.fromStatus ?? "-"} -> ${e.toStatus} (${e.cause}) @${String(e.at)}\n`);
          }
        }
      }
      return 0;
    }
    const records = await journal.list();
    if (json) {
      process.stdout.write(`${JSON.stringify({ schema: "relay.effects/1", effects: records })}\n`);
    } else if (records.length === 0) {
      process.stdout.write("(no effects)\n");
    } else {
      for (const record of records) {
        const ref = record.remoteRef === undefined ? "" : ` remote=${record.remoteRef}`;
        process.stdout.write(`${record.status.padEnd(9)} ${record.key}${ref}  ${record.id}\n`);
      }
    }
    return 0;
  } finally {
    journal.close();
  }
}

/**
 * Canonicalized identity for a path that may not exist: symlinks are
 * resolved when possible, otherwise the parent directory's real path is
 * combined with the entry name.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/** dev+ino identity — catches hardlink aliases where path comparison cannot. */
function sameInode(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * The journal and its SQLite sidecars (-wal/-shm/-journal) must never be the
 * export target: writing the document there would truncate the input.
 * Collisions are detected by canonical path AND inode so relative-path,
 * symlink, and hardlink aliases are all refused.
 */
function outputCollidesWithJournal(output: string, journalPath: string): boolean {
  // Protect sidecar names under BOTH the configured path and the canonical
  // (realpath) database path: when --storage is itself a symlink alias, the
  // real journal's sidecars live next to the resolved target and may not
  // exist yet — comparing only alias-sidecar names would miss them.
  const journalCanon = canonicalPath(journalPath);
  const bases = journalCanon === journalPath ? [journalPath] : [journalPath, journalCanon];
  const targets = bases.flatMap((b) => [b, `${b}-wal`, `${b}-shm`, `${b}-journal`]);
  const canonicalOutput = canonicalPath(output);
  for (const target of targets) {
    if (canonicalPath(target) === canonicalOutput) return true;
    if (existsSync(output) && sameInode(output, target)) return true;
  }
  return false;
}

async function runStatusCommand(rest: string[], cwd: string): Promise<number> {
  let storage: string | undefined;
  let output: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--storage") {
      storage = requireValue(rest, i + 1, "--storage");
      i += 1;
    } else if (arg === "--output") {
      output = requireValue(rest, i + 1, "--output");
      i += 1;
    } else usageError(`unknown argument for status: ${arg}`);
  }
  const journalPath = storage ?? join(cwd, ".relay", "storage.db");

  if (output !== undefined && outputCollidesWithJournal(output, journalPath)) {
    process.stderr.write(
      `relay: refusing to write status output over the journal or its SQLite sidecars: ${output}\n`,
    );
    return 2;
  }

  // The journal open is strictly read-only: a missing or unreadable journal
  // yields a document that says so, never a mutated or fabricated sample.
  // Read/sample failures get the same generic unavailable document — raw
  // error text stays on stderr and never enters the published document.
  let histories: import("@relay/core").EffectHistory[] = [];
  let malformedRows = 0;
  let unavailableReason: string | undefined;
  try {
    const reader = await SqliteEffectJournalReader.open({ path: journalPath });
    try {
      const result = await reader.readJournal();
      histories = result.histories;
      malformedRows = result.malformedRows;
    } finally {
      reader.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`relay: status journal unavailable: ${message}\n`);
    if (message.includes("not found")) unavailableReason = "no journal file at the configured path";
    else if (message.includes("not a Relay effect journal") || message.includes("missing required column")) {
      unavailableReason = "file at the configured path is not a recognized Relay effect journal";
    } else unavailableReason = "journal could not be opened or sampled read-only";
  }

  const document = buildStatusDocument({ histories, malformedRows, unavailableReason }, new Date());
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (output === undefined) {
    process.stdout.write(serialized);
  } else {
    try {
      await writeFile(output, serialized, "utf8");
    } catch (err) {
      process.stderr.write(`relay: cannot write status output: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    process.stdout.write(`wrote ${output}\n`);
  }
  return unavailableReason === undefined ? 0 : 1;
}

async function runExportCommand(rest: string[], cwd: string): Promise<number> {
  let output: string | undefined;
  let workspace: string | undefined;
  let capabilities: string | undefined;
  let adapterContext: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--output") { output = requireValue(rest, i + 1, "--output"); i += 1; }
    else if (arg === "--workspace") { workspace = requireValue(rest, i + 1, "--workspace"); i += 1; }
    else if (arg === "--capabilities") { capabilities = requireValue(rest, i + 1, "--capabilities"); i += 1; }
    else if (arg === "--adapter-context") { adapterContext = requireValue(rest, i + 1, "--adapter-context"); i += 1; }
    else usageError(`unknown argument for export: ${arg}`);
  }
  const ws = workspace ?? cwd;
  const result = await exportCapsule({
    workspace: ws,
    output: output ?? join(cwd, "relay-capsule.tar.gz"),
    capabilitiesPath: capabilities,
    adapterContextPath: adapterContext,
  });
  process.stdout.write(
    `exported ${result.capsulePath}\nmanifest ${result.manifestSha256}\nentries ${result.entryCount}  effects ${result.manifest.counts.effects}  artifact records ${result.manifest.counts.artifactRecords}\n`,
  );
  return 0;
}

async function runImportCommand(rest: string[], cwd: string): Promise<number> {
  let workspace: string | undefined;
  let overwrite = false;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) break;
    if (arg === "--workspace") { workspace = requireValue(rest, i + 1, "--workspace"); i += 1; }
    else if (arg === "--overwrite") overwrite = true;
    else if (arg.startsWith("--")) usageError(`unknown argument for import: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) usageError("import requires exactly one <capsule> path");
  const capsule = positional[0] ?? "";
  const ws = workspace ?? cwd;
  try {
    const result = await importCapsule({ capsule, workspace: ws, allowOverwrite: overwrite });
    process.stdout.write(
      `imported capsule into ${ws}\n` +
        `effects ${result.counts.effects}  artifact records ${result.counts.artifactRecords}` +
        (result.importedContract ? `  contract .relay/relay.capabilities.yaml` : "") +
        `\nactivation pending: run 'relay doctor' in the target workspace before resuming\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`relay: import rejected: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

async function runLineageCommand(rest: string[], cwd: string): Promise<number> {
  const args = parseArtifactFlags(rest, cwd);
  if (args.positional.length !== 1) usageError("lineage requires exactly one <artifact-ref>");
  const ref = args.positional[0] ?? "";
  const store = await ArtifactStore.open({ root: args.artifacts });
  const { root, problems } = await store.lineage(ref);
  if (root === undefined) {
    process.stderr.write(`relay: unknown artifact ${ref}\n`);
    return 66;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ schema: "relay.lineage/1", root, problems })}\n`);
  } else {
    process.stdout.write(`${renderLineageTree(root)}\n`);
    for (const problem of problems) process.stdout.write(`! ${problem}\n`);
  }
  return 0;
}

export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.stderr.write(USAGE);
    return 64;
  }
  if (command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "artifacts") {
    return runArtifactsCommand(rest, cwd);
  }
  if (command === "lineage") {
    return runLineageCommand(rest, cwd);
  }
  if (command === "effects") {
    return runEffectsCommand(rest, cwd);
  }
  if (command === "export") {
    return runExportCommand(rest, cwd);
  }
  if (command === "import") {
    return runImportCommand(rest, cwd);
  }
  if (command === "status") {
    return runStatusCommand(rest, cwd);
  }
  if (command === "task") {
    return runTaskCommand(rest, cwd);
  }
  if (command !== "doctor") {
    usageError(`unknown command: ${command}`);
  }

  const args = parseDoctorArgs(rest, cwd);
  const probes: DoctorProbeSpec[] = [
    { id: "pi", label: "Pi CLI", run: async () => probePiCli() },
    { id: "storage", label: "SQLite storage", run: () => probeSqliteStorage({ path: args.storage }) },
    { id: "artifacts", label: "Artifact root", run: () => probeArtifactRoot({ root: args.artifacts }) },
  ];
  const result = await runDoctor({
    relayVersion: RELAY_VERSION,
    context: { cwd },
    probes,
  });

  // Capability contract (M3/M7) resolution order:
  //   1. explicit --capabilities PATH (operator responsibility);
  //   2. the contract imported with .relay (dirname(--storage)/relay.capabilities.yaml);
  //   3. the workspace-root authoring copy (dirname of that .relay directory).
  // Import and doctor therefore resolve the SAME contract that the import
  // committed — a new .relay can never be activated against an old contract.
  const fsModule = await import("node:fs");
  const relayDir = dirname(args.storage);
  const importedContract = join(relayDir, "relay.capabilities.yaml");
  const rootContract = join(dirname(relayDir), "relay.capabilities.yaml");
  const capabilitiesPath = args.capabilities ?? (fsModule.existsSync(importedContract)
    ? importedContract
    : rootContract);
  const hasCapabilities = fsModule.existsSync(capabilitiesPath);
  let capabilityLines: string[] = [];
  let capabilitiesJson: unknown = undefined;
  let exitCode = doctorExitCode(result);
  if (hasCapabilities) {
    try {
      const { evaluation } = await evaluateCapabilitiesFile({ path: capabilitiesPath });
      capabilityLines = [
        `capabilities (${capabilitiesPath}):`,
        ...evaluation.results.map(
          (r) =>
            `  [${r.state}${r.required ? "/required" : "/optional"}] ${r.label} (${r.id}): ${r.detail}`,
        ),
        `activation: ${evaluation.decision}`,
      ];
      capabilitiesJson = evaluation;
      const capabilityCode = activationExitCode(evaluation);
      exitCode = Math.max(exitCode, capabilityCode) as 0 | 1 | 2;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      capabilityLines = [`capabilities (${capabilitiesPath}): invalid — ${message}`];
      capabilitiesJson = { error: message };
      exitCode = 2;
    }
  }

  if (args.json) {
    const payload = {
      ...result,
      ...(capabilitiesJson === undefined ? {} : { capabilities: capabilitiesJson }),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    let text = formatDoctorReport(result);
    // The formatted report ends with summary/exit-code lines; splice the
    // capability section above them and re-derive the printed exit code.
    const lines = text.split("\n");
    const summaryIndex = lines.findIndex((line) => line.startsWith("summary:"));
    const head = summaryIndex === -1 ? lines : lines.slice(0, summaryIndex);
    const tail = summaryIndex === -1 ? [] : lines.slice(summaryIndex);
    tail[1] = `exit code: ${exitCode}`;
    text = [...head, ...capabilityLines, ...tail].join("\n");
    process.stdout.write(`${text}\n`);
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // Compatibility mitigation for nodejs/node#56645: on Windows,
  // process.exit() can tear the event loop down while an async handle is
  // mid-close (e.g. an undici keep-alive socket), tripping libuv's
  // UV_HANDLE_CLOSING assert in async.c. The upstream fix (nodejs/node#61999,
  // merged 2026-07-24) may not be in the runtime in use — the crash was
  // still reproduced on Node 24.13 — so a brief drain before the forced
  // exit gives pending closes time to settle. This is a heuristic
  // mitigation, not a guarantee that all pending I/O has completed.
  const exitAfterDrain = async (code: number): Promise<never> => {
    if (process.platform === "win32") await new Promise((r) => setTimeout(r, 100));
    return process.exit(code);
  };
  main(process.argv.slice(2)).then(
    (code) => exitAfterDrain(code),
    (err) => {
      process.stderr.write(`relay: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
      void exitAfterDrain(70);
    },
  );
}

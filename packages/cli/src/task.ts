/**
 * `relay task` — durable task commands (v0.2).
 *
 * The CLI is a thin shell over TaskRuntime + SqliteTaskStore + the effect
 * journal in the SAME .relay/storage.db. Agent mechanics and app-specific
 * effect specs stay in app code: `--adapter-module PATH` dynamically
 * imports a module exporting:
 *
 *   export const adapter: AgentAdapter              // optional
 *   export const effects: TaskEffectSpec[]          // optional
 *   export async function run(ctx)                  // optional: `task run` leg
 *   export async function continuation(ctx)         // optional: `task resume` leg
 *   export async function capabilities()            // optional: "READY"|"BLOCKED"
 *
 * Exit codes follow doctor: 0 ok | 1 waiting/degraded | 2 blocked | 64 usage | 66 unknown task.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TaskRuntime,
  type AgentAdapter,
  type TaskEffectSpec,
  type TaskResumeContext,
  type TaskStore,
  type EffectJournal,
} from "@relay/core";
import { SqliteEffectJournal, SqliteEpistemicStore, SqliteTaskStore } from "@relay/storage-sqlite";
import { envNumber } from "./env.js";

interface TaskCliDeps {
  runtime: TaskRuntime;
  store: TaskStore;
  journal: EffectJournal;
  epistemic: SqliteEpistemicStore;
}

export interface TaskAdapterModule {
  adapter?: AgentAdapter | undefined;
  effects?: TaskEffectSpec[] | (() => TaskEffectSpec[]) | undefined;
  capabilities?: (() => Promise<"READY" | "DEGRADED" | "BLOCKED">) | undefined;
  run?: ((ctx: { runtime: TaskRuntime; task: import("@relay/core").DurableTask; cwd: string }) => Promise<void>) | undefined;
  continuation?: ((ctx: TaskResumeContext) => Promise<void>) | undefined;
}

function taskUsageError(message: string): never {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(64);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    taskUsageError(`${flag} requires a value`);
  }
  return value;
}

interface Parsed {
  positional: string[];
  json: boolean;
  storage: string | undefined;
  adapterModule: string | undefined;
  ref: string | undefined;
  adapterId: string;
}

function parseTaskArgs(argv: string[]): Parsed {
  const out: Parsed = {
    positional: [],
    json: false,
    storage: undefined,
    adapterModule: undefined,
    ref: undefined,
    adapterId: "pi",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--json") out.json = true;
    else if (arg === "--storage") {
      out.storage = requireValue(argv, i + 1, "--storage");
      i += 1;
    } else if (arg === "--adapter-module") {
      out.adapterModule = requireValue(argv, i + 1, "--adapter-module");
      i += 1;
    } else if (arg === "--ref") {
      out.ref = requireValue(argv, i + 1, "--ref");
      i += 1;
    } else if (arg === "--agent" || arg === "--adapter") {
      out.adapterId = requireValue(argv, i + 1, arg);
      i += 1;
    } else if (arg.startsWith("--")) taskUsageError(`unknown argument: ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

async function openDeps(storage: string | undefined, cwd: string): Promise<TaskCliDeps> {
  const path = storage ?? join(cwd, ".relay", "storage.db");
  const store = await SqliteTaskStore.open({ path });
  const journal = await SqliteEffectJournal.open({ path });
  const epistemic = await SqliteEpistemicStore.open({ path });
  return {
    runtime: new TaskRuntime({ store, journal, epistemic }),
    store,
    journal,
    epistemic,
  };
}

async function loadModule(spec: string | undefined, cwd: string): Promise<TaskAdapterModule> {
  if (spec === undefined) return {};
  const href = spec.startsWith("file:") ? spec : pathToFileURL(resolve(cwd, spec)).href;
  const mod = (await import(href)) as TaskAdapterModule;
  return mod;
}

function printTask(task: { id: string; status: string; goal: string; updatedAt: number }, extra = ""): void {
  process.stdout.write(`${task.id}  ${task.status.padEnd(9)}  ${task.goal}${extra}\n`);
}

export async function runTaskCommand(argv: string[], cwd: string): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined) taskUsageError("task requires a subcommand: create|run|list|show|events|approve|resume|cancel");
  const args = parseTaskArgs(rest);
  const deps = await openDeps(args.storage, cwd);
  try {
    switch (sub) {
      case "create": {
        const goal = args.positional.join(" ").trim();
        if (goal === "") taskUsageError("task create requires a goal");
        const task = await deps.runtime.createTask({ goal, adapter: args.adapterId });
        if (args.json) process.stdout.write(`${JSON.stringify({ schema: "relay.task/1", task })}\n`);
        else printTask(task);
        return 0;
      }
      case "list": {
        const tasks = await deps.runtime.listTasks();
        if (args.json) {
          process.stdout.write(`${JSON.stringify({ schema: "relay.tasks/1", tasks })}\n`);
        } else if (tasks.length === 0) {
          process.stdout.write("(no tasks)\n");
        } else {
          for (const task of tasks) printTask(task);
        }
        return 0;
      }
      case "show": {
        const id = args.positional[0] ?? taskUsageError("task show requires <task-id>");
        const snapshot = await deps.runtime.snapshot(id).catch(() => undefined);
        if (snapshot === undefined) {
          process.stderr.write(`relay: unknown task ${id}\n`);
          return 66;
        }
        process.stdout.write(`${JSON.stringify({ schema: "relay.task-snapshot/1", ...snapshot }, null, 2)}\n`);
        return 0;
      }
      case "events": {
        const id = args.positional[0] ?? taskUsageError("task events requires <task-id>");
        const events = await deps.runtime.taskEvents(id);
        if (args.json) {
          process.stdout.write(`${JSON.stringify({ schema: "relay.task-events/1", events })}\n`);
        } else {
          for (const e of events) {
            process.stdout.write(`#${String(e.seq)} ${e.type}${e.ref !== undefined ? ` ${e.ref}` : ""} @${String(e.at)}\n`);
          }
          if (events.length === 0) process.stdout.write("(no events)\n");
        }
        return 0;
      }
      case "run": {
        const goal = args.positional.join(" ").trim();
        if (goal === "") taskUsageError("task run requires a goal");
        const mod = await loadModule(args.adapterModule, cwd);
        const task = await deps.runtime.createTask({ goal, adapter: args.adapterId });
        process.stdout.write(`task ${task.id}\n`);
        if (mod.adapter?.attach !== undefined) {
          const ref = await mod.adapter.attach(task, { instruction: goal, workspace: cwd });
          await deps.runtime.attachAgent(task.id, ref);
          process.stdout.write(`agent attached: ${ref.sessionFile ?? ref.sessionId ?? "?"}\n`);
        }
        if (mod.run !== undefined) {
          await mod.run({ runtime: deps.runtime, task: await deps.runtime.getTask(task.id).then((t) => t ?? task), cwd });
        }
        const after = await deps.runtime.getTask(task.id);
        const pending = await deps.runtime.pendingAwaits(task.id);
        const status = after?.status ?? "ACTIVE";
        process.stdout.write(`status ${status}${pending.length > 0 ? ` (waiting on ${pending.map((a) => a.kind).join(",")})` : ""}\n`);
        return status === "BLOCKED" ? 2 : 0;
      }
      case "approve": {
        const id = args.positional[0] ?? taskUsageError("task approve requires <task-id>");
        const task = await deps.runtime.getTask(id);
        if (task === undefined) {
          process.stderr.write(`relay: unknown task ${id}\n`);
          return 66;
        }
        const resolved = await deps.runtime.approve(id, args.ref);
        process.stdout.write(`approved ${id}  resolved-awaits ${String(resolved.length)}\n`);
        // The approval is bound to (kind, requestHash) — print that identity
        // so a human can see exactly which request was authorized.
        for (const wait of resolved) {
          if (wait.binding !== undefined) {
            process.stdout.write(
              `  ${wait.ref ?? "?"} kind=${wait.binding.kind} requestHash=${wait.binding.requestHash}\n`,
            );
          }
        }
        return 0;
      }
      case "resume": {
        const id = args.positional[0] ?? taskUsageError("task resume requires <task-id>");
        const mod = await loadModule(args.adapterModule, cwd);
        const effects = typeof mod.effects === "function" ? mod.effects() : mod.effects;
        const outcome = await deps.runtime.resume(id, {
          adapter: mod.adapter,
          effects,
          continuation: mod.continuation,
          capabilities: mod.capabilities,
          workspace: cwd,
          // Test-only seam (RELAY_TEST_LEASE_CLAIM_DELAY_MS): pauses between
          // the pre-claim read and the lease claim to reproduce the
          // stale-snapshot window in a real process.
          claimDelayMs: envNumber("RELAY_TEST_LEASE_CLAIM_DELAY_MS"),
        });
        switch (outcome.outcome) {
          case "resumed":
            process.stdout.write(`resumed ${id}${outcome.agent?.detail !== undefined ? `  ${outcome.agent.detail}` : ""}\n`);
            return 0;
          case "completed":
            process.stdout.write(`completed ${id} (already)\n`);
            return 0;
          case "waiting":
            process.stdout.write(`waiting ${id}\n`);
            return 1;
          case "blocked":
            process.stdout.write(`blocked ${id}  reason=${outcome.reason}\n`);
            return outcome.reason === "await-pending" ? 1 : 2;
          case "busy":
            // Another live process owns this task's run lease — a distinct
            // non-success outcome, never a second run.
            process.stdout.write(`busy ${id}  owner-pid=${String(outcome.owner.ownerPid)}\n`);
            return 2;
          case "cancelled":
            process.stdout.write(`cancelled ${id}\n`);
            return 2;
          case "missing":
            process.stderr.write(`relay: unknown task ${id}\n`);
            return 66;
          default:
            return 0;
        }
      }
      case "cancel": {
        const id = args.positional[0] ?? taskUsageError("task cancel requires <task-id>");
        const ok = await deps.runtime.cancel(id);
        process.stdout.write(ok ? `cancelled ${id}\n` : `no-op ${id}\n`);
        return ok ? 0 : 66;
      }
      default:
        taskUsageError(`unknown task subcommand: ${sub}`);
    }
    return 64;
  } finally {
    if ("close" in deps.store) (deps.store as { close(): void }).close();
    if ("close" in deps.journal) (deps.journal as { close(): void }).close();
    if ("close" in deps.epistemic) (deps.epistemic as { close(): void }).close();
  }
}

/** IPC barriers expose exact interleavings; no scheduling sleeps. */
import { TaskRuntime } from "@relay/core";
import { SqliteEffectJournal, SqliteTaskStore } from "../../src/index.js";

const [path, taskId, mode] = process.argv.slice(2);
if (path === undefined || taskId === undefined) throw new Error("missing fixture arguments");
const store = await SqliteTaskStore.open({ path });
const journal = await SqliteEffectJournal.open({ path });
const runtime = new TaskRuntime({ store, journal });
let release!: () => void;
const held = new Promise<void>((resolve) => { release = resolve; });
process.on("message", (message) => { if (message === "release") release(); });

try {
  let result: unknown;
  if (mode === "complete") {
    const list = journal.list.bind(journal);
    journal.list = async () => {
      const snapshot = await list();
      process.send?.({ type: "checking" });
      await held;
      return snapshot;
    };
    result = await runtime.complete(taskId);
  } else if (mode === "resume") {
    result = await runtime.resume(taskId, {
      adapter: { id: "pi", resume: async () => {
        process.send?.({ type: "adapter" });
        await held;
        return { resumed: true, status: "completed" };
      } },
      continuation: async () => { process.send?.({ type: "continued" }); },
    });
  } else {
    if (mode === "admission") {
      const get = journal.getByKey.bind(journal);
      let first = true;
      journal.getByKey = async (key) => {
        if (first) {
          first = false;
          process.send?.({ type: "admitted" });
          await held;
        }
        return get(key);
      };
    }
    result = await runtime.runTaskEffect(taskId, {
      name: "publish", kind: "test/publish", request: { release: 1 }, approvalRequired: false,
      execute: async () => {
        process.send?.({ type: "executing" });
        await held;
        return { remoteRef: "pub-1" };
      },
    });
  }
  process.send?.({ type: "done", result });
} catch (error) {
  process.send?.({ type: "error", message: String(error) });
  process.exitCode = 1;
} finally {
  store.close();
  journal.close();
  process.disconnect?.();
}

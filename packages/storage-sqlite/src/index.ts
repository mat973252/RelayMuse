/**
 * @relay/storage-sqlite — Relay-owned durable facts (M0: probe boundary only).
 *
 * M0 scope: a real accessibility probe suitable for the capability doctor.
 * This is NOT a Pi session store and holds no session data yet.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProbeOutcome } from "@relay/core";

export {
  SqliteEffectJournal,
  SqliteEffectJournalReader,
  type JournalReadResult,
  type SqliteEffectJournalOptions,
} from "./journal.js";

export interface StorageProbeOptions {
  /** Filesystem path of the SQLite database file to probe. */
  path: string;
}

/**
 * Real probe: opens (creating if needed) the database file through the
 * built-in `node:sqlite` driver, writes and reads back exactly one probe
 * row, removes it, and closes the handle. Failures are reported, never
 * thrown, so the doctor can render them.
 */
export async function probeSqliteStorage(options: StorageProbeOptions): Promise<ProbeOutcome> {
  const { path } = options;
  try {
    const sqlite = await import("node:sqlite");
    await mkdir(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS relay_m0_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO relay_m0_probe (id, marker) VALUES (1, ?)").run("relay-m0-probe");
      const row = db.prepare("SELECT marker FROM relay_m0_probe WHERE id = 1").get() as
        | { marker?: unknown }
        | undefined;
      if (row === undefined || row.marker !== "relay-m0-probe") {
        return { status: "fail", detail: `sqlite probe row mismatch at ${path}` };
      }
      db.exec("DELETE FROM relay_m0_probe");
      return { status: "ok", detail: `node:sqlite read/write verified at ${path}` };
    } finally {
      db.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const major = Number.parseInt(process.versions.node, 10);
    const hint =
      major < 23 && message.includes("sqlite")
        ? " (node:sqlite needs --experimental-sqlite on Node < 23.4)"
        : "";
    return { status: "fail", detail: `sqlite probe failed at ${path}: ${message}${hint}` };
  }
}
export { SqliteEpistemicStore, type SqliteEpistemicStoreOptions } from "./epistemic-store.js";
export { SqliteTaskStore, type SqliteTaskStoreOptions } from "./task-store.js";

/**
 * @relay/storage-sqlite — durable task store (v0.2).
 *
 * Task continuity state lives in the SAME database file as the effect
 * journal (.relay/storage.db) under separate relay_task_* tables. Same
 * discipline as the journal: WAL + synchronous=FULL, every mutation commits
 * its task events in one transaction, guarded transitions reject instead of
 * emitting. A SIGKILL between statements never loses a committed mutation
 * and never leaves a row change without its event (or vice versa).
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentRef,
  AwaitBinding,
  AwaitKind,
  AwaitPoint,
  AwaitResolveOutcome,
  AwaitStatus,
  DurableTask,
  TaskArtifactLink,
  TaskEffectLink,
  TaskEvent,
  TaskEventInput,
  TaskEventType,
  TaskStatus,
  TaskStore,
} from "@relay/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_tasks (
  id               TEXT PRIMARY KEY,
  goal             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','WAITING','BLOCKED','COMPLETED','CANCELLED')),
  adapter          TEXT NOT NULL,
  agent_ref_json   TEXT,
  investigation_id TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_task_awaits (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES relay_tasks(id),
  kind         TEXT NOT NULL CHECK (kind IN ('USER','APPROVAL','TIME','EXTERNAL','RECONCILIATION')),
  status       TEXT NOT NULL CHECK (status IN ('PENDING','RESOLVED','CANCELLED')),
  reason       TEXT NOT NULL,
  ref          TEXT,
  binding_json TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS relay_task_awaits_task ON relay_task_awaits(task_id, status);
CREATE TABLE IF NOT EXISTS relay_task_events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES relay_tasks(id),
  type    TEXT NOT NULL CHECK (type IN (
            'TASK_CREATED','AGENT_ATTACHED','WAIT_CREATED','WAIT_RESOLVED',
            'EFFECT_PREPARED','EFFECT_CONFIRMED','EFFECT_FAILED','EFFECT_UNKNOWN',
            'ARTIFACT_CREATED','EVIDENCE_ADDED',
            'TASK_BLOCKED','TASK_RESUMED','TASK_COMPLETED','TASK_CANCELLED')),
  ref     TEXT,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_task_events_task ON relay_task_events(task_id, seq);
CREATE TABLE IF NOT EXISTS relay_task_effects (
  task_id   TEXT NOT NULL REFERENCES relay_tasks(id),
  effect_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  kind      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (task_id, effect_id)
);
CREATE INDEX IF NOT EXISTS relay_task_effects_task ON relay_task_effects(task_id);
CREATE TABLE IF NOT EXISTS relay_task_artifacts (
  task_id     TEXT NOT NULL REFERENCES relay_tasks(id),
  artifact_id TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('input','generated','evidence')),
  at          INTEGER NOT NULL,
  PRIMARY KEY (task_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS relay_task_artifacts_task ON relay_task_artifacts(task_id);
`;

interface TaskRow {
  id: string;
  goal: string;
  status: string;
  adapter: string;
  agent_ref_json: string | null;
  investigation_id: string | null;
  created_at: number;
  updated_at: number;
}

interface AwaitRow {
  id: string;
  task_id: string;
  kind: string;
  status: string;
  reason: string;
  ref: string | null;
  binding_json: string | null;
  created_at: number;
  resolved_at: number | null;
}

interface EventRow {
  seq: number;
  task_id: string;
  type: string;
  ref: string | null;
  at: number;
}

interface EffectLinkRow {
  task_id: string;
  effect_id: string;
  key: string;
  kind: string;
  at: number;
}

interface ArtifactLinkRow {
  task_id: string;
  artifact_id: string;
  role: string;
  at: number;
}

function toTask(row: TaskRow): DurableTask {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status as TaskStatus,
    adapter: row.adapter,
    agentRef: row.agent_ref_json === null ? undefined : (JSON.parse(row.agent_ref_json) as AgentRef),
    investigationId: row.investigation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAwait(row: AwaitRow): AwaitPoint {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as AwaitKind,
    status: row.status as AwaitStatus,
    reason: row.reason,
    ref: row.ref ?? undefined,
    // Legacy rows have NULL binding_json -> unbound; they fail closed.
    binding: row.binding_json === null ? undefined : (JSON.parse(row.binding_json) as AwaitBinding),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export interface SqliteTaskStoreOptions {
  /** Filesystem path of the shared Relay database file. */
  path: string;
}

export class SqliteTaskStore implements TaskStore {
  private readonly db: import("node:sqlite").DatabaseSync;

  private constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
  }

  static async open(options: SqliteTaskStoreOptions): Promise<SqliteTaskStore> {
    const sqlite = await import("node:sqlite");
    await mkdir(dirname(options.path), { recursive: true });
    const db = new sqlite.DatabaseSync(options.path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    // Additive migration for databases created before binding_json existed.
    const cols = db.prepare("PRAGMA table_info(relay_task_awaits)").all() as { name: string }[];
    if (!cols.some((col) => col.name === "binding_json")) {
      db.exec("ALTER TABLE relay_task_awaits ADD COLUMN binding_json TEXT");
    }
    return new SqliteTaskStore(db);
  }

  close(): void {
    this.db.close();
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private appendEvents(taskId: string, events: readonly TaskEventInput[] | undefined): void {
    if (events === undefined || events.length === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO relay_task_events (task_id, type, ref, at) VALUES (?, ?, ?, ?)",
    );
    for (const event of events) {
      insert.run(taskId, event.type, event.ref ?? null, event.at);
    }
  }

  async insertTask(task: DurableTask, events?: readonly TaskEventInput[]): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO relay_tasks
             (id, goal, status, adapter, agent_ref_json, investigation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.goal,
          task.status,
          task.adapter,
          task.agentRef === undefined ? null : JSON.stringify(task.agentRef),
          task.investigationId ?? null,
          task.createdAt,
          task.updatedAt,
        );
      this.appendEvents(task.id, events);
    });
  }

  async getTask(id: string): Promise<DurableTask | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  async listTasks(): Promise<DurableTask[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_tasks ORDER BY created_at, id")
      .all() as unknown as TaskRow[];
    return rows.map(toTask);
  }

  async transitionTask(
    id: string,
    expected: readonly TaskStatus[] | undefined,
    to: TaskStatus,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined> {
    let result: DurableTask | undefined;
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (row === undefined) return;
      if (expected !== undefined && !expected.includes(row.status as TaskStatus)) return;
      this.db
        .prepare("UPDATE relay_tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(to, at, id);
      this.appendEvents(id, events);
      result = toTask({ ...row, status: to, updated_at: at });
    });
    return result;
  }

  async updateTask(
    id: string,
    patch: { agentRef?: AgentRef | undefined; investigationId?: string | undefined },
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<void> {
    this.transaction(() => {
      const sets: string[] = ["updated_at = ?"];
      const values: unknown[] = [at];
      if (patch.agentRef !== undefined) {
        sets.push("agent_ref_json = ?");
        values.push(JSON.stringify(patch.agentRef));
      }
      if (patch.investigationId !== undefined) {
        sets.push("investigation_id = ?");
        values.push(patch.investigationId);
      }
      values.push(id);
      this.db.prepare(`UPDATE relay_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
      this.appendEvents(id, events);
    });
  }

  async insertAwait(await_: AwaitPoint, events?: readonly TaskEventInput[]): Promise<void> {
    this.transaction(() => {
      this.insertAwaitRow(await_);
      this.appendEvents(await_.taskId, events);
    });
  }

  /**
   * Atomic parking: await row + events + the ACTIVE|WAITING -> WAITING
   * transition in ONE transaction, guarded so terminal tasks reject the
   * whole park (no half-committed await row, no orphan event).
   */
  async parkAwait(
    taskId: string,
    await_: AwaitPoint,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined> {
    let result: DurableTask | undefined;
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_tasks WHERE id = ?").get(taskId) as
        | TaskRow
        | undefined;
      // Guarded park: a missing/terminal task rejects the whole commit —
      // no await row, no event, no status change leaks through.
      if (row === undefined) return;
      if (row.status !== "ACTIVE" && row.status !== "WAITING") return;
      this.insertAwaitRow(await_);
      this.appendEvents(taskId, events);
      this.db
        .prepare("UPDATE relay_tasks SET status = 'WAITING', updated_at = ? WHERE id = ?")
        .run(at, taskId);
      result = toTask({ ...row, status: "WAITING", updated_at: at });
    });
    return result;
  }

  private insertAwaitRow(await_: AwaitPoint): void {
    this.db
      .prepare(
        `INSERT INTO relay_task_awaits (id, task_id, kind, status, reason, ref, binding_json, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        await_.id,
        await_.taskId,
        await_.kind,
        await_.status,
        await_.reason,
        await_.ref ?? null,
        await_.binding === undefined ? null : JSON.stringify(await_.binding),
        await_.createdAt,
        await_.resolvedAt ?? null,
      );
  }

  async getAwait(id: string): Promise<AwaitPoint | undefined> {
    const row = this.db.prepare("SELECT * FROM relay_task_awaits WHERE id = ?").get(id) as
      | AwaitRow
      | undefined;
    return row === undefined ? undefined : toAwait(row);
  }

  async awaits(taskId: string): Promise<AwaitPoint[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_task_awaits WHERE task_id = ? ORDER BY created_at, id")
      .all(taskId) as unknown as AwaitRow[];
    return rows.map(toAwait);
  }

  async pendingAwaits(taskId: string, kind?: AwaitKind): Promise<AwaitPoint[]> {
    const rows = (
      kind === undefined
        ? this.db
            .prepare("SELECT * FROM relay_task_awaits WHERE task_id = ? AND status = 'PENDING' ORDER BY created_at, id")
            .all(taskId)
        : this.db
            .prepare(
              "SELECT * FROM relay_task_awaits WHERE task_id = ? AND status = 'PENDING' AND kind = ? ORDER BY created_at, id",
            )
            .all(taskId, kind)
    ) as unknown as AwaitRow[];
    return rows.map(toAwait);
  }

  /**
   * PENDING -> RESOLVED exactly once. A second resolve finds status
   * 'RESOLVED' and reports "already-resolved": no update, no event — the
   * no-op is provable from the row, not from memory.
   */
  async resolveAwait(id: string, at: number, events?: readonly TaskEventInput[]): Promise<AwaitResolveOutcome> {
    let outcome: AwaitResolveOutcome = "invalid";
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM relay_task_awaits WHERE id = ?").get(id) as
        | AwaitRow
        | undefined;
      if (row === undefined) return;
      if (row.status === "RESOLVED") {
        outcome = "already-resolved";
        return;
      }
      if (row.status !== "PENDING") return;
      this.db
        .prepare("UPDATE relay_task_awaits SET status = 'RESOLVED', resolved_at = ? WHERE id = ? AND status = 'PENDING'")
        .run(at, id);
      this.appendEvents(row.task_id, events);
      outcome = "resolved";
    });
    return outcome;
  }

  async linkEffect(link: TaskEffectLink, events?: readonly TaskEventInput[]): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO relay_task_effects (task_id, effect_id, key, kind, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(link.taskId, link.effectId, link.key, link.kind, link.at);
      this.appendEvents(link.taskId, events);
    });
  }

  async taskEffects(taskId: string): Promise<TaskEffectLink[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_task_effects WHERE task_id = ? ORDER BY at, effect_id")
      .all(taskId) as unknown as EffectLinkRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      effectId: row.effect_id,
      key: row.key,
      kind: row.kind,
      at: row.at,
    }));
  }

  async linkArtifact(link: TaskArtifactLink, events?: readonly TaskEventInput[]): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO relay_task_artifacts (task_id, artifact_id, role, at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(link.taskId, link.artifactId, link.role, link.at);
      this.appendEvents(link.taskId, events);
    });
  }

  async taskArtifacts(taskId: string): Promise<TaskArtifactLink[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_task_artifacts WHERE task_id = ? ORDER BY at, artifact_id")
      .all(taskId) as unknown as ArtifactLinkRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      artifactId: row.artifact_id,
      role: row.role as TaskArtifactLink["role"],
      at: row.at,
    }));
  }

  async taskEvents(taskId: string): Promise<TaskEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM relay_task_events WHERE task_id = ? ORDER BY seq")
      .all(taskId) as unknown as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      taskId: row.task_id,
      type: row.type as TaskEventType,
      ref: row.ref ?? undefined,
      at: row.at,
    }));
  }
}

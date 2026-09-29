/**
 * @relay/core — Durable Task domain (v0.2 / Muse-style task continuity).
 *
 * Relay orchestrates continuity, not intelligence: this module maintains the
 * minimal cross-process/cross-time state a long-running personal-agent task
 * needs — task identity, lifecycle, wait reasons, resume gates — while the
 * agent adapter (Pi first) keeps owning its loop, sessions, deferred handles
 * and resume semantics.
 *
 * Invariants enforced here (see tasks/NEXT_ITERATION_MUSE_RUNTIME_V02.md §7):
 *   1. An UNKNOWN/SUBMITTED effect is never blindly re-executed; recovery
 *      goes through reconciliation.
 *   2. An unresolved APPROVAL/USER await blocks resume; the task never jumps
 *      past a human gate.
 *   3. A missing REQUIRED capability moves the task to BLOCKED.
 *   4. Resolving the same await twice is a no-op ("already-resolved").
 *   5. Resuming twice never duplicates an external effect (journal dedup).
 *
 * All state derives from durable facts (rows + events); no narrated progress
 * is ever persisted.
 */
import { randomUUID } from "node:crypto";
import {
  EffectNeedsReconciliationError,
  hashRequest,
  runEffect,
  type EffectJournal,
  type EffectRecord,
  type ReconcileOutcome,
} from "./effect.js";
import type { ActivationDecision } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export type TaskStatus = "ACTIVE" | "WAITING" | "BLOCKED" | "COMPLETED" | "CANCELLED";

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "CANCELLED"];

/** Await kinds implemented for real in v0.2. TIME/EXTERNAL are schema seams only. */
export type AwaitKind = "USER" | "APPROVAL" | "TIME" | "EXTERNAL" | "RECONCILIATION";

export type AwaitStatus = "PENDING" | "RESOLVED" | "CANCELLED";

/**
 * What an await authorizes — a non-secret, inspectable identity. For APPROVAL
 * awaits this binds the approval to the effect kind plus the canonical
 * request hash: approving request A can never silently authorize a drifted
 * request B under the same effect name (and legacy waits without a binding
 * fail closed — they authorize nothing).
 */
export interface AwaitBinding {
  kind: string;
  requestHash: string;
}

/** Reserved ref prefix for the adapter-owned EXTERNAL wait. */
export function adapterWaitRef(adapterId: string): string {
  return `adapter:${adapterId}`;
}

/**
 * Reference to the agent-side continuation material. Opaque to Relay: the
 * adapter interprets it. For Pi this carries a session file/id and, when the
 * agent is parked on a deferred response, the Pi DeferredHandle fields.
 */
export interface AgentRef {
  sessionId?: string | undefined;
  sessionFile?: string | undefined;
  deferredRef?:
    | {
        provider: string;
        modelId: string;
        api: string;
        id: string;
      }
    | undefined;
}

export interface DurableTask {
  id: string;
  /** What the user asked for; immutable intent, not a progress narrative. */
  goal: string;
  status: TaskStatus;
  /** Adapter id that owns agent continuation (v0.2 ships "pi"). */
  adapter: string;
  /** Agent continuation reference; never a copy of agent state. */
  agentRef: AgentRef | undefined;
  /** Optional link into the epistemic store. */
  investigationId: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface AwaitPoint {
  id: string;
  taskId: string;
  kind: AwaitKind;
  status: AwaitStatus;
  /** Human-readable wait reason (why the task is parked). */
  reason: string;
  /**
   * Optional gated-entity reference. For APPROVAL awaits this is the effect
   * name the approval unlocks; undefined covers every gated effect. For the
   * adapter-owned EXTERNAL wait it is `adapter:<adapterId>`.
   */
  ref: string | undefined;
  /** Non-secret identity of what this wait authorizes (APPROVAL waits). */
  binding: AwaitBinding | undefined;
  createdAt: number;
  resolvedAt: number | undefined;
}

export type TaskEventType =
  | "TASK_CREATED"
  | "AGENT_ATTACHED"
  | "WAIT_CREATED"
  | "WAIT_RESOLVED"
  | "EFFECT_PREPARED"
  | "EFFECT_CONFIRMED"
  | "EFFECT_FAILED"
  | "EFFECT_UNKNOWN"
  | "ARTIFACT_CREATED"
  | "EVIDENCE_ADDED"
  | "TASK_BLOCKED"
  | "TASK_RESUMED"
  | "TASK_COMPLETED"
  | "TASK_CANCELLED";

/**
 * One committed task fact. Controlled fields only — identity, type, a single
 * entity reference, time — mirroring the effect-event discipline: event rows
 * are evidence, never free-form prose.
 */
export interface TaskEvent {
  seq: number;
  taskId: string;
  type: TaskEventType;
  /** Entity this event is about: await id, effect key, artifact id, ... */
  ref: string | undefined;
  at: number;
}

/** Event payload supplied with a mutation; seq is assigned by the store. */
export interface TaskEventInput {
  type: TaskEventType;
  ref?: string | undefined;
  at: number;
}

export type TaskArtifactRole = "input" | "generated" | "evidence";

export interface TaskEffectLink {
  taskId: string;
  effectId: string;
  key: string;
  kind: string;
  at: number;
}

export interface TaskArtifactLink {
  taskId: string;
  artifactId: string;
  role: TaskArtifactRole;
  at: number;
}

export type AwaitResolveOutcome = "resolved" | "already-resolved" | "invalid";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Durable task store port. Implementations must commit each mutation and its
 * events atomically (same discipline as the effect journal) and must survive
 * process death mid-sequence.
 */
export interface TaskStore {
  insertTask(task: DurableTask, events?: readonly TaskEventInput[]): Promise<void>;
  getTask(id: string): Promise<DurableTask | undefined>;
  listTasks(): Promise<DurableTask[]>;
  /**
   * Guarded status transition + events in one commit. `expected === undefined`
   * accepts any current status; otherwise the update commits only when the
   * current status is in `expected`. Returns the post-update row, or
   * undefined when the guard rejected the transition.
   */
  transitionTask(
    id: string,
    expected: readonly TaskStatus[] | undefined,
    to: TaskStatus,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined>;
  /** Patch reference fields (agentRef / investigationId) + optional events. */
  updateTask(
    id: string,
    patch: { agentRef?: AgentRef | undefined; investigationId?: string | undefined },
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<void>;

  insertAwait(await_: AwaitPoint, events?: readonly TaskEventInput[]): Promise<void>;
  /**
   * Atomic parking: await row + events + WAITING transition in ONE commit,
   * guarded to ACTIVE|WAITING sources. Returns the post-update task, or
   * undefined when the guard rejected the park (nothing committed). A crash
   * after this returns can never leave "await committed, task still ACTIVE".
   */
  parkAwait(
    taskId: string,
    await_: AwaitPoint,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined>;
  getAwait(id: string): Promise<AwaitPoint | undefined>;
  awaits(taskId: string): Promise<AwaitPoint[]>;
  pendingAwaits(taskId: string, kind?: AwaitKind): Promise<AwaitPoint[]>;
  /** PENDING -> RESOLVED once; second call is a no-op. */
  resolveAwait(id: string, at: number, events?: readonly TaskEventInput[]): Promise<AwaitResolveOutcome>;

  linkEffect(link: TaskEffectLink, events?: readonly TaskEventInput[]): Promise<void>;
  taskEffects(taskId: string): Promise<TaskEffectLink[]>;

  linkArtifact(link: TaskArtifactLink, events?: readonly TaskEventInput[]): Promise<void>;
  taskArtifacts(taskId: string): Promise<TaskArtifactLink[]>;

  taskEvents(taskId: string): Promise<TaskEvent[]>;
}

/**
 * Minimal structural read-port over the epistemic store for derived task
 * snapshots. `@relay/epistemic` stores satisfy this without adaptation;
 * Relay never re-asks an LLM what the task "knows".
 */
export interface TaskEpistemicReader {
  claims(investigationId: string): Promise<{ id: string; statement: string }[]>;
  evidenceFor(claimId: string): Promise<{ ref: { kind: string; ref: string }; supports: boolean }[]>;
  beliefFor(
    claimId: string,
  ): Promise<{ status: "accepted" | "rejected" | "undetermined"; confidence: number } | undefined>;
  decisions(investigationId: string): Promise<{ summary: string; resolvedAt: number | undefined }[]>;
}

/** What the adapter reports about the agent-side continuation. */
export interface AgentState {
  status: "idle" | "waiting-deferred" | "running" | "unknown";
  detail?: string | undefined;
}

export interface AgentResumeResult {
  /** true when the adapter actually continued agent-side work. */
  resumed: boolean;
  /**
   * Explicit recovery semantics (adapters that predate this field report
   * undefined for every outcome; the runtime maps a bare `{resumed:false}`
   * to "pending", never to failure):
   *   completed — the agent leg finished; continuation may run.
   *   pending   — work is still in flight agent-side; park durably, poll later.
   *   idle      — legitimately nothing to resume (no deferred run); not an error.
   *   failed    — the agent leg failed; park resumably, do not continue.
   */
  status?: "completed" | "pending" | "idle" | "failed" | undefined;
  detail?: string | undefined;
  /** Adapter-produced output payload (e.g. deferred response text). */
  output?: unknown;
}

/** The agent-continuation contract adapters implement. Pi is the first. */
export interface AgentAdapter {
  readonly id: string;
  attach?(task: DurableTask, context: AgentAttachContext): Promise<AgentRef>;
  inspect?(ref: AgentRef): Promise<AgentState>;
  resume?(ref: AgentRef, context: AgentResumeContext): Promise<AgentResumeResult>;
}

export interface AgentAttachContext {
  /** Instruction for the agent leg (defaults to the task goal). */
  instruction?: string | undefined;
  workspace?: string | undefined;
}

export interface AgentResumeContext {
  task: DurableTask;
  workspace?: string | undefined;
}

// ---------------------------------------------------------------------------
// Effect decision layer (§8 — deliberately tiny)
// ---------------------------------------------------------------------------

export type EffectDecision = "ALLOW" | "ASK" | "DENY";

/**
 * A task effect as the application declares it. `name` becomes part of the
 * journal key `task/<taskId>/<name>` — the prefix makes the durable
 * task↔effect link recoverable by scanning the journal after a crash.
 */
export interface TaskEffectSpec {
  name: string;
  kind: string;
  request: unknown;
  /** Non-secret intent description stored on the effect record. */
  intent?: string | undefined;
  /** true: external mutation gated behind a resolved APPROVAL await. */
  approvalRequired: boolean;
  execute: (ctx: { record: EffectRecord }) => Promise<unknown>;
  reconcile?: ((record: EffectRecord) => Promise<ReconcileOutcome>) | undefined;
}

export function taskEffectKey(taskId: string, name: string): string {
  return `task/${taskId}/${name}`;
}

/** Key prefix used to rediscover a task's effects after a crash. */
export function taskEffectPrefix(taskId: string): string {
  return `task/${taskId}/`;
}

// ---------------------------------------------------------------------------
// Task runtime
// ---------------------------------------------------------------------------

export interface TaskRuntimeDeps {
  store: TaskStore;
  journal: EffectJournal;
  /** Optional epistemic reader for derived snapshots. */
  epistemic?: TaskEpistemicReader | undefined;
  /**
   * Resume-gate capability probe. Returns the activation decision; when
   * absent the gate treats the environment as READY.
   */
  capabilities?: (() => Promise<ActivationDecision>) | undefined;
  now?: (() => number) | undefined;
}

export interface CreateTaskInput {
  id?: string | undefined;
  goal: string;
  adapter: string;
  agentRef?: AgentRef | undefined;
  investigationId?: string | undefined;
}

export interface CreateAwaitInput {
  kind: AwaitKind;
  reason: string;
  ref?: string | undefined;
  binding?: AwaitBinding | undefined;
  id?: string | undefined;
}

export type RunTaskEffectOutcome =
  | { decision: "awaiting-approval"; awaitId: string }
  | { decision: "needs-reconciliation"; effectId: string; status: "SUBMITTED" | "UNKNOWN" }
  | {
      decision: "executed";
      outcome: import("./effect.js").EffectOutcome;
      effectId: string;
    };

export type TaskResumeOutcome =
  | { outcome: "resumed"; agent: AgentResumeResult | undefined }
  | { outcome: "completed"; already: boolean }
  | { outcome: "cancelled" }
  | { outcome: "missing" }
  | { outcome: "blocked"; reason: "capability" | "await-pending" | "effect-unsettled" | "adapter"; awaits?: AwaitPoint[] }
  /** Durably parked — e.g. the agent leg is still pending; resume re-polls. */
  | { outcome: "waiting"; awaits: AwaitPoint[] };

export interface TaskResumeContext {
  task: DurableTask;
  runtime: TaskRuntime;
  adapter: AgentAdapter | undefined;
  workspace?: string | undefined;
}

export interface ResumeTaskOptions {
  adapter?: AgentAdapter | undefined;
  /** Application effect registry (for reconciliation inside the gate). */
  effects?: readonly TaskEffectSpec[] | undefined;
  /** App continuation invoked after the gate and adapter.resume pass. */
  continuation?: ((ctx: TaskResumeContext) => Promise<void>) | undefined;
  /** Per-call capability override. */
  capabilities?: (() => Promise<ActivationDecision>) | undefined;
  workspace?: string | undefined;
}

/** Derived recovery snapshot — all fields come from durable facts. */
export interface TaskSnapshot {
  taskId: string;
  goal: string;
  adapter: string;
  status: TaskStatus;
  waitingFor: {
    awaitId: string;
    kind: AwaitKind;
    reason: string;
    ref: string | undefined;
    binding: AwaitBinding | undefined;
  }[];
  confirmed: string[];
  unknowns: string[];
  artifacts: TaskArtifactLink[];
  unresolvedEffects: { effectId: string; key: string; status: string }[];
  agentRef: AgentRef | undefined;
  investigationId: string | undefined;
  investigation?: {
    claims: { id: string; statement: string; belief: string }[];
    evidence: { claimId: string; kind: string; ref: string; supports: boolean }[];
    decisions: { summary: string; resolved: boolean }[];
  } | undefined;
}

export class TaskNotActiveError extends Error {
  readonly task: DurableTask;

  constructor(task: DurableTask) {
    super(`task ${task.id} is ${task.status}; run task effects only while ACTIVE`);
    this.name = "TaskNotActiveError";
    this.task = task;
  }
}

/** Effect execution is refused while any wait is still pending on the task. */
export class TaskAwaitPendingError extends Error {
  readonly task: DurableTask;
  readonly awaits: AwaitPoint[];

  constructor(task: DurableTask, awaits: AwaitPoint[]) {
    super(
      `task ${task.id} has ${String(awaits.length)} pending wait(s) ` +
        `(${awaits.map((a) => a.kind).join(", ")}); resolve them before executing effects`,
    );
    this.name = "TaskAwaitPendingError";
    this.task = task;
    this.awaits = awaits;
  }
}

/** Completion is refused while any effect is PREPARED/SUBMITTED/UNKNOWN. */
export class TaskUnsettledEffectsError extends Error {
  readonly taskId: string;
  readonly effects: { key: string; status: string }[];

  constructor(taskId: string, effects: { key: string; status: string }[]) {
    super(
      `task ${taskId} has unsettled effects ` +
        `(${effects.map((e) => `${e.key}:${e.status}`).join(", ")}); reconcile them first`,
    );
    this.name = "TaskUnsettledEffectsError";
    this.taskId = taskId;
    this.effects = effects;
  }
}

export class TaskRuntime {
  private readonly deps: TaskRuntimeDeps;
  private readonly now: () => number;

  constructor(deps: TaskRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------------- task lifecycle ----------------

  async createTask(input: CreateTaskInput): Promise<DurableTask> {
    if (input.goal.trim().length === 0) throw new Error("task goal must not be empty");
    if (input.adapter.trim().length === 0) throw new Error("task adapter must not be empty");
    const at = this.now();
    const task: DurableTask = {
      id: input.id ?? randomUUID(),
      goal: input.goal,
      status: "ACTIVE",
      adapter: input.adapter,
      agentRef: input.agentRef,
      investigationId: input.investigationId,
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.store.insertTask(task, [{ type: "TASK_CREATED", at }]);
    return task;
  }

  async getTask(id: string): Promise<DurableTask | undefined> {
    return this.deps.store.getTask(id);
  }

  async listTasks(): Promise<DurableTask[]> {
    return this.deps.store.listTasks();
  }

  /** Record the agent-side continuation reference (adapter attach result). */
  async attachAgent(taskId: string, agentRef: AgentRef): Promise<DurableTask> {
    const task = await this.requireTask(taskId);
    if (task.status === "COMPLETED" || task.status === "CANCELLED") {
      throw new Error(`cannot attach an agent to a ${task.status} task`);
    }
    const at = this.now();
    await this.deps.store.updateTask(
      taskId,
      { agentRef },
      at,
      [{ type: "AGENT_ATTACHED", ref: agentRef.sessionId ?? agentRef.sessionFile, at }],
    );
    return this.requireTask(taskId);
  }

  /** Link the task to an epistemic investigation (reference, not a copy). */
  async attachInvestigation(taskId: string, investigationId: string): Promise<void> {
    const at = this.now();
    await this.deps.store.updateTask(
      taskId,
      { investigationId },
      at,
      [{ type: "EVIDENCE_ADDED", ref: `investigation:${investigationId}`, at }],
    );
  }

  /** Record that new evidence landed in the epistemic store for this task. */
  async recordEvidenceEvent(taskId: string, evidenceRef: string): Promise<void> {
    const at = this.now();
    await this.deps.store.updateTask(taskId, {}, at, [{ type: "EVIDENCE_ADDED", ref: evidenceRef, at }]);
  }

  // ---------------- awaits ----------------

  /** Park the task on a wait point; ACTIVE|WAITING -> WAITING. */
  async createAwait(taskId: string, input: CreateAwaitInput): Promise<AwaitPoint> {
    const task = await this.requireTask(taskId);
    if (task.status !== "ACTIVE" && task.status !== "WAITING") {
      throw new Error(`cannot await on a ${task.status} task`);
    }
    const at = this.now();
    const await_: AwaitPoint = {
      id: input.id ?? randomUUID(),
      taskId,
      kind: input.kind,
      status: "PENDING",
      reason: input.reason,
      ref: input.ref,
      binding: input.binding,
      createdAt: at,
      resolvedAt: undefined,
    };
    // Await row + WAIT_CREATED + the WAITING transition commit as one unit.
    await this.deps.store.parkAwait(taskId, await_, at, [
      { type: "WAIT_CREATED", ref: await_.id, at },
    ]);
    return await_;
  }

  /**
   * Resolve one await by id. Idempotent: resolving an already-resolved await
   * returns "already-resolved" and emits nothing.
   */
  async resolveAwait(awaitId: string): Promise<AwaitResolveOutcome> {
    const at = this.now();
    return this.deps.store.resolveAwait(awaitId, at, [
      { type: "WAIT_RESOLVED", ref: awaitId, at },
    ]);
  }

  async pendingAwaits(taskId: string, kind?: AwaitKind): Promise<AwaitPoint[]> {
    return this.deps.store.pendingAwaits(taskId, kind);
  }

  /**
   * Resolve every pending APPROVAL await on the task (optionally narrowed to
   * one gated ref). Idempotent: already-resolved awaits stay resolved, so a
   * double approve can never re-gate or duplicate anything downstream.
   */
  async approve(taskId: string, ref?: string): Promise<AwaitPoint[]> {
    const pending = await this.deps.store.pendingAwaits(taskId, "APPROVAL");
    const resolved: AwaitPoint[] = [];
    for (const await_ of pending) {
      if (ref !== undefined && await_.ref !== undefined && await_.ref !== ref) continue;
      const outcome = await this.resolveAwait(await_.id);
      if (outcome === "resolved") {
        const settled = await this.deps.store.getAwait(await_.id);
        if (settled !== undefined) resolved.push(settled);
      }
    }
    return resolved;
  }

  /**
   * Whether an APPROVAL await bound to THIS spec's (kind, request) resolved.
   * A resolved legacy await without a binding authorizes nothing — it fails
   * closed, so an old database can never silently approve a new request.
   */
  private async isApprovedFor(taskId: string, spec: TaskEffectSpec): Promise<boolean> {
    const requestHash = hashRequest(spec.request);
    const awaits = await this.deps.store.awaits(taskId);
    return awaits.some(
      (a) =>
        a.kind === "APPROVAL" &&
        a.status === "RESOLVED" &&
        (a.ref === undefined || a.ref === spec.name) &&
        a.binding !== undefined &&
        a.binding.kind === spec.kind &&
        a.binding.requestHash === requestHash,
    );
  }

  // ---------------- effect decision + execution ----------------

  /**
   * Task-scoped effect entry point. Implements the decision layer:
   *   approvalRequired && no resolved APPROVAL await covering it
   *     -> ASK: park the task on an APPROVAL await, do not execute.
   *   otherwise -> run through the shared effect journal (exactly-once
   *   semantics already live there), link task -> effect.
   * An effect previously left SUBMITTED/UNKNOWN surfaces as
   * "needs-reconciliation" unless a reconcile was supplied — never a blind
   * retry.
   */
  async runTaskEffect(taskId: string, spec: TaskEffectSpec): Promise<RunTaskEffectOutcome> {
    const task = await this.requireTask(taskId);
    if (task.status !== "ACTIVE") throw new TaskNotActiveError(task);
    const key = taskEffectKey(taskId, spec.name);
    const existing = await this.deps.journal.getByKey(key);

    if (existing !== undefined && (existing.status === "SUBMITTED" || existing.status === "UNKNOWN")) {
      if (spec.reconcile === undefined) {
        await this.ensureReconciliationAwait(taskId, spec.name, existing);
        return { decision: "needs-reconciliation", effectId: existing.id, status: existing.status };
      }
      // Read-only reconciliation is never re-gated on approval or pending
      // waits: it establishes remote truth, it cannot re-execute.
      return this.executeTaskEffect(taskId, spec);
    }

    // CONFIRMED/FAILED records are dedup'd inside runEffect — a read-only,
    // idempotent re-entry that never re-executes, even while parked.
    if (existing !== undefined && (existing.status === "CONFIRMED" || existing.status === "FAILED")) {
      return this.executeTaskEffect(taskId, spec);
    }

    const pending = await this.deps.store.pendingAwaits(taskId);
    if (pending.length > 0) {
      throw new TaskAwaitPendingError(task, pending);
    }

    if (spec.approvalRequired) {
      const approved = await this.isApprovedFor(taskId, spec);
      if (!approved) {
        const await_ = await this.ensureApprovalAwait(taskId, spec);
        return { decision: "awaiting-approval", awaitId: await_.id };
      }
    }

    return this.executeTaskEffect(taskId, spec);
  }

  /** Journal + link, no task-level gates (gates live in the callers). */
  private async executeTaskEffect(taskId: string, spec: TaskEffectSpec): Promise<RunTaskEffectOutcome> {
    const key = taskEffectKey(taskId, spec.name);
    const hadRecord = (await this.deps.journal.getByKey(key)) !== undefined;
    const outcome = await runEffect({
      key,
      kind: spec.kind,
      request: spec.request,
      intent: spec.intent,
      replay: "never",
      journal: this.deps.journal,
      execute: spec.execute,
      ...(spec.reconcile === undefined ? {} : { reconcile: spec.reconcile }),
      now: this.now,
    });
    const record = await this.deps.journal.getByKey(key);
    if (record !== undefined) {
      await this.linkEffect(taskId, record, !hadRecord, outcome);
    }
    return { decision: "executed", outcome, effectId: record?.id ?? "" };
  }

  private async ensureApprovalAwait(taskId: string, spec: TaskEffectSpec): Promise<AwaitPoint> {
    const binding: AwaitBinding = { kind: spec.kind, requestHash: hashRequest(spec.request) };
    const pending = await this.deps.store.pendingAwaits(taskId, "APPROVAL");
    // A pending wait with a DIFFERENT binding never satisfies this spec —
    // the task parks on a new, correctly-bound wait instead.
    const existing = pending.find(
      (a) =>
        (a.ref === undefined || a.ref === spec.name) &&
        a.binding !== undefined &&
        a.binding.kind === binding.kind &&
        a.binding.requestHash === binding.requestHash,
    );
    if (existing !== undefined) return existing;
    return this.createAwait(taskId, {
      kind: "APPROVAL",
      reason: `effect "${spec.name}" (${spec.kind}) requires human approval of request ${binding.requestHash.slice(0, 12)}`,
      ref: spec.name,
      binding,
    });
  }

  private async ensureReconciliationAwait(
    taskId: string,
    name: string,
    record: EffectRecord,
  ): Promise<AwaitPoint> {
    const pending = await this.deps.store.pendingAwaits(taskId, "RECONCILIATION");
    const existing = pending.find((a) => a.ref === name);
    if (existing !== undefined) return existing;
    return this.createAwait(taskId, {
      kind: "RECONCILIATION",
      reason: `effect "${name}" is ${record.status}; reconcile before resuming`,
      ref: name,
    });
  }

  /**
   * Atomic task -> effect link. `fresh` distinguishes a brand-new PREPARED
   * record (fires EFFECT_PREPARED) from a re-entry. Events mirror the
   * committed effect state, never an interpretation of it.
   */
  private async linkEffect(
    taskId: string,
    record: EffectRecord,
    fresh: boolean,
    outcome?: import("./effect.js").EffectOutcome,
  ): Promise<void> {
    const at = this.now();
    const events: TaskEventInput[] = [];
    if (fresh) events.push({ type: "EFFECT_PREPARED", ref: record.key, at });
    if (outcome !== undefined) {
      const type =
        outcome.status === "confirmed"
          ? "EFFECT_CONFIRMED"
          : outcome.status === "failed"
            ? "EFFECT_FAILED"
            : "EFFECT_UNKNOWN";
      events.push({ type, ref: record.key, at });
    }
    await this.deps.store.linkEffect(
      { taskId, effectId: record.id, key: record.key, kind: record.kind, at },
      events,
    );
  }

  // ---------------- artifact links ----------------

  /** Link an existing artifact record to the task (reference, not a copy). */
  async linkArtifact(taskId: string, artifactId: string, role: TaskArtifactRole): Promise<void> {
    const at = this.now();
    await this.deps.store.linkArtifact({ taskId, artifactId, role, at }, [
      { type: "ARTIFACT_CREATED", ref: artifactId, at },
    ]);
  }

  async taskArtifacts(taskId: string): Promise<TaskArtifactLink[]> {
    return this.deps.store.taskArtifacts(taskId);
  }

  // ---------------- recovery / resume gate ----------------

  /**
   * The recovery protocol (§7), fixed order:
   *   load task -> status check -> capability gate -> unsettled effects
   *   (reconcile, never blind retry) -> unresolved awaits -> agentRef ->
   *   adapter.resume -> app continuation.
   */
  async resume(taskId: string, options: ResumeTaskOptions = {}): Promise<TaskResumeOutcome> {
    const task = await this.deps.store.getTask(taskId);
    if (task === undefined) return { outcome: "missing" };
    if (task.status === "COMPLETED") return { outcome: "completed", already: true };
    if (task.status === "CANCELLED") return { outcome: "cancelled" };

    const capabilities = options.capabilities ?? this.deps.capabilities;
    if (capabilities !== undefined) {
      const decision = await capabilities();
      if (decision === "BLOCKED") {
        const at = this.now();
        await this.deps.store.transitionTask(taskId, ["ACTIVE", "WAITING", "BLOCKED"], "BLOCKED", at, [
          { type: "TASK_BLOCKED", ref: "capability", at },
        ]);
        return { outcome: "blocked", reason: "capability" };
      }
    }

    const unsettled = await this.unsettledEffects(taskId);
    for (const record of unsettled) {
      if (record.status !== "SUBMITTED" && record.status !== "UNKNOWN") continue;
      const spec = this.specFor(taskId, record, options.effects);
      if (spec?.reconcile === undefined) {
        const await_ = await this.ensureReconciliationAwait(taskId, spec?.name ?? record.key, record);
        return { outcome: "blocked", reason: "effect-unsettled", awaits: [await_] };
      }
      const outcome = await this.runTaskEffectGuarded(taskId, spec, task);
      if (outcome?.decision === "awaiting-approval") {
        // The approval await is pending again; the awaits check below parks
        // the task on it rather than mislabeling it as reconciliation.
        continue;
      }
      const settled = await this.deps.journal.getByKey(record.key);
      if (settled !== undefined && settled.status === "CONFIRMED") {
        // The remote truth is established; a leftover RECONCILIATION wait on
        // this effect no longer gates the task.
        for (const stale of await this.deps.store.pendingAwaits(taskId, "RECONCILIATION")) {
          if (stale.ref === spec.name) await this.resolveAwait(stale.id);
        }
      }
      if (settled !== undefined && (settled.status === "SUBMITTED" || settled.status === "UNKNOWN")) {
        const await_ = await this.ensureReconciliationAwait(taskId, spec.name, settled);
        return { outcome: "waiting", awaits: [await_] };
      }
      if (settled !== undefined && settled.status === "FAILED") {
        const at = this.now();
        await this.deps.store.transitionTask(taskId, ["ACTIVE", "WAITING", "BLOCKED"], "BLOCKED", at, [
          { type: "TASK_BLOCKED", ref: `effect-failed:${spec.name}`, at },
        ]);
        return { outcome: "blocked", reason: "effect-unsettled" };
      }
    }

    // Human/application awaits gate BEFORE the adapter gate: a pending
    // USER/APPROVAL/app-EXTERNAL wait must never be skipped to poll the
    // adapter. The only EXTERNAL wait exempted is the adapter-owned one
    // (reserved ref `adapter:<id>`), re-polled below once humans cleared.
    const adapterRef = adapterWaitRef(task.adapter);
    const pending = await this.deps.store.pendingAwaits(taskId);
    const adapterWait = pending.find((a) => a.kind === "EXTERNAL" && a.ref === adapterRef);
    const blockers = pending.filter((a) => a !== adapterWait);
    if (blockers.length > 0) {
      if (task.status !== "WAITING") {
        const at = this.now();
        await this.deps.store.transitionTask(taskId, ["ACTIVE", "BLOCKED"], "WAITING", at);
      }
      return { outcome: "blocked", reason: "await-pending", awaits: blockers };
    }

    // Adapter gate: continue the agent leg only once every other gate
    // cleared. pending/failed park the task durably (resumable later); only
    // completed/idle let the continuation run.
    let agent: AgentResumeResult | undefined;
    const adapter = options.adapter;
    if (adapter?.resume !== undefined) {
      agent = await adapter.resume(task.agentRef ?? {}, {
        task,
        workspace: options.workspace,
      });
      const status = agent.status ?? (agent.resumed ? "completed" : "pending");
      if (status === "pending" || status === "failed") {
        const wait = await this.createAwait(taskId, {
          kind: "EXTERNAL",
          ref: adapterRef,
          reason: agent.detail ?? `agent leg ${status}`,
        });
        return status === "failed"
          ? { outcome: "blocked", reason: "adapter", awaits: [wait] }
          : { outcome: "waiting", awaits: [wait] };
      }
      // completed | idle: the agent leg is done or legitimately absent; the
      // adapter-owned wait — and only that one — clears automatically.
      if (adapterWait !== undefined) await this.resolveAwait(adapterWait.id);
    } else if (adapterWait !== undefined) {
      // A parked adapter wait without an adapter to poll it stays blocked.
      return { outcome: "blocked", reason: "await-pending", awaits: [adapterWait] };
    }

    const at = this.now();
    if (task.status !== "ACTIVE") {
      await this.deps.store.transitionTask(taskId, ["WAITING", "BLOCKED"], "ACTIVE", at, [
        { type: "TASK_RESUMED", at },
      ]);
    } else {
      await this.deps.store.updateTask(taskId, {}, at, [{ type: "TASK_RESUMED", at }]);
    }
    const resumedTask = (await this.deps.store.getTask(taskId)) ?? task;

    if (options.continuation !== undefined) {
      await options.continuation({ task: resumedTask, runtime: this, adapter, workspace: options.workspace });
    }
    return { outcome: "resumed", agent };
  }

  /**
   * Re-entry used by the resume gate: like runTaskEffect but tolerant of the
   * task not being ACTIVE (a WAITING/BLOCKED task still gets reconciled).
   */
  /**
   * Re-entry used by the resume gate for SUBMITTED/UNKNOWN records only:
   * journal-level reconciliation — read-only, it can never re-execute — so
   * it deliberately bypasses the ACTIVE/pending-approval gates that protect
   * fresh executions in runTaskEffect.
   */
  private async runTaskEffectGuarded(
    taskId: string,
    spec: TaskEffectSpec,
    task: DurableTask,
  ): Promise<RunTaskEffectOutcome | undefined> {
    void task;
    return this.executeTaskEffect(taskId, spec);
  }

  private specFor(
    taskId: string,
    record: EffectRecord,
    effects: readonly TaskEffectSpec[] | undefined,
  ): TaskEffectSpec | undefined {
    const prefix = taskEffectPrefix(taskId);
    if (!record.key.startsWith(prefix)) return undefined;
    const name = record.key.slice(prefix.length);
    return effects?.find((spec) => spec.name === name) ?? { name, kind: record.kind, request: undefined, approvalRequired: false, execute: async () => undefined, reconcile: undefined };
  }

  /** Task effects: link table ∪ journal rows under the task's key prefix. */
  private async unsettledEffects(taskId: string): Promise<EffectRecord[]> {
    const linked = await this.deps.store.taskEffects(taskId);
    const byKey = new Map<string, EffectRecord>();
    for (const link of linked) {
      const record = await this.deps.journal.get(link.effectId);
      if (record !== undefined) byKey.set(record.key, record);
    }
    // Self-heal: an effect committed just before a crash may precede its
    // task link; the key convention lets recovery still find it.
    const prefix = taskEffectPrefix(taskId);
    for (const record of await this.deps.journal.list()) {
      if (record.key.startsWith(prefix) && !byKey.has(record.key)) {
        byKey.set(record.key, record);
        await this.deps.store.linkEffect(
          { taskId, effectId: record.id, key: record.key, kind: record.kind, at: this.now() },
        );
      }
    }
    return [...byKey.values()].filter(
      (record) => record.status === "PREPARED" || record.status === "SUBMITTED" || record.status === "UNKNOWN",
    );
  }

  // ---------------- snapshot ----------------

  /** Recovery snapshot: every field is derived from durable facts. */
  async snapshot(taskId: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(taskId);
    const [pendingAwaits, artifacts, links] = await Promise.all([
      this.deps.store.pendingAwaits(taskId),
      this.deps.store.taskArtifacts(taskId),
      this.deps.store.taskEffects(taskId),
    ]);
    const prefix = taskEffectPrefix(taskId);
    const effectKeys = new Set(links.map((l) => l.key));
    for (const record of await this.deps.journal.list()) {
      if (record.key.startsWith(prefix)) effectKeys.add(record.key);
    }
    const confirmed: string[] = [];
    const unknowns: string[] = [];
    const unresolvedEffects: { effectId: string; key: string; status: string }[] = [];
    for (const key of [...effectKeys].sort()) {
      const record = await this.deps.journal.getByKey(key);
      if (record === undefined) continue;
      const short = key.slice(prefix.length);
      if (record.status === "CONFIRMED") confirmed.push(short);
      else if (record.status === "FAILED") unknowns.push(`${short} (failed)`);
      else {
        unresolvedEffects.push({ effectId: record.id, key: short, status: record.status });
        if (record.status !== "PREPARED") unknowns.push(`${short} (${record.status.toLowerCase()})`);
      }
    }

    let investigation: TaskSnapshot["investigation"];
    if (this.deps.epistemic !== undefined && task.investigationId !== undefined) {
      const reader = this.deps.epistemic;
      const claims = await reader.claims(task.investigationId);
      const claimRows: { id: string; statement: string; belief: string }[] = [];
      const evidenceRows: { claimId: string; kind: string; ref: string; supports: boolean }[] = [];
      for (const claim of claims) {
        const belief = await reader.beliefFor(claim.id);
        claimRows.push({ id: claim.id, statement: claim.statement, belief: belief?.status ?? "undetermined" });
        for (const ev of await reader.evidenceFor(claim.id)) {
          evidenceRows.push({ claimId: claim.id, kind: ev.ref.kind, ref: ev.ref.ref, supports: ev.supports });
        }
      }
      const decisions = await reader.decisions(task.investigationId);
      investigation = {
        claims: claimRows,
        evidence: evidenceRows,
        decisions: decisions.map((d) => ({ summary: d.summary, resolved: d.resolvedAt !== undefined })),
      };
      // Accepted beliefs also count as confirmed knowledge; undetermined and
      // contradicted knowledge counts toward unknowns.
      for (const row of claimRows) {
        if (row.belief === "accepted") confirmed.push(`claim:${row.statement}`);
        else if (row.belief === "undetermined") unknowns.push(`claim:${row.statement}`);
      }
    }

    return {
      taskId: task.id,
      goal: task.goal,
      adapter: task.adapter,
      status: task.status,
      waitingFor: pendingAwaits.map((a) => ({
        awaitId: a.id,
        kind: a.kind,
        reason: a.reason,
        ref: a.ref,
        binding: a.binding,
      })),
      confirmed,
      unknowns,
      artifacts,
      unresolvedEffects,
      agentRef: task.agentRef,
      investigationId: task.investigationId,
      investigation,
    };
  }

  async taskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.deps.store.taskEvents(taskId);
  }

  // ---------------- terminal transitions ----------------

  async complete(taskId: string): Promise<boolean> {
    const pending = await this.deps.store.pendingAwaits(taskId);
    if (pending.length > 0) {
      throw new Error(`cannot complete: ${String(pending.length)} await(s) still pending`);
    }
    // An unsettled effect (PREPARED/SUBMITTED/UNKNOWN) must never be reported
    // as success: completion is refused until recovery reconciles it.
    const unsettled = await this.unsettledEffects(taskId);
    if (unsettled.length > 0) {
      throw new TaskUnsettledEffectsError(
        taskId,
        unsettled.map((e) => ({ key: e.key, status: e.status })),
      );
    }
    const at = this.now();
    const updated = await this.deps.store.transitionTask(taskId, ["ACTIVE", "WAITING", "BLOCKED"], "COMPLETED", at, [
      { type: "TASK_COMPLETED", at },
    ]);
    return updated !== undefined;
  }

  async cancel(taskId: string): Promise<boolean> {
    const at = this.now();
    const updated = await this.deps.store.transitionTask(
      taskId,
      ["ACTIVE", "WAITING", "BLOCKED"],
      "CANCELLED",
      at,
      [{ type: "TASK_CANCELLED", at }],
    );
    return updated !== undefined;
  }

  private async requireTask(taskId: string): Promise<DurableTask> {
    const task = await this.deps.store.getTask(taskId);
    if (task === undefined) throw new Error(`unknown task ${taskId}`);
    return task;
  }
}

export { EffectNeedsReconciliationError };

// ---------------------------------------------------------------------------
// In-memory TaskStore (tests, ephemeral drivers)
// ---------------------------------------------------------------------------

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, DurableTask>();
  private readonly awaitMap = new Map<string, AwaitPoint>();
  private readonly effectLinks: TaskEffectLink[] = [];
  private readonly artifactLinks: TaskArtifactLink[] = [];
  private readonly events: TaskEvent[] = [];
  private seq = 0;

  private pushEvents(taskId: string, events: readonly TaskEventInput[] | undefined): void {
    for (const event of events ?? []) {
      this.seq += 1;
      this.events.push({ seq: this.seq, taskId, type: event.type, ref: event.ref, at: event.at });
    }
  }

  async insertTask(task: DurableTask, events?: readonly TaskEventInput[]): Promise<void> {
    this.tasks.set(task.id, { ...task });
    this.pushEvents(task.id, events);
  }

  async getTask(id: string): Promise<DurableTask | undefined> {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : { ...task };
  }

  async listTasks(): Promise<DurableTask[]> {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((task) => ({ ...task }));
  }

  async transitionTask(
    id: string,
    expected: readonly TaskStatus[] | undefined,
    to: TaskStatus,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined> {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    if (expected !== undefined && !expected.includes(task.status)) return undefined;
    const updated = { ...task, status: to, updatedAt: at };
    this.tasks.set(id, updated);
    this.pushEvents(id, events);
    return { ...updated };
  }

  async updateTask(
    id: string,
    patch: { agentRef?: AgentRef | undefined; investigationId?: string | undefined },
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<void> {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    const updated = {
      ...task,
      ...(patch.agentRef !== undefined ? { agentRef: patch.agentRef } : {}),
      ...(patch.investigationId !== undefined ? { investigationId: patch.investigationId } : {}),
      updatedAt: at,
    };
    this.tasks.set(id, updated);
    this.pushEvents(id, events);
  }

  async insertAwait(await_: AwaitPoint, events?: readonly TaskEventInput[]): Promise<void> {
    this.awaitMap.set(await_.id, { ...await_ });
    this.pushEvents(await_.taskId, events);
  }

  async parkAwait(
    taskId: string,
    await_: AwaitPoint,
    at: number,
    events?: readonly TaskEventInput[],
  ): Promise<DurableTask | undefined> {
    // Validate BEFORE mutating so a rejected park commits nothing.
    const task = this.tasks.get(taskId);
    if (task === undefined) return undefined;
    if (task.status !== "ACTIVE" && task.status !== "WAITING") return undefined;
    this.awaitMap.set(await_.id, { ...await_ });
    this.pushEvents(taskId, events);
    const updated = { ...task, status: "WAITING" as const, updatedAt: at };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  async getAwait(id: string): Promise<AwaitPoint | undefined> {
    const found = this.awaitMap.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async awaits(taskId: string): Promise<AwaitPoint[]> {
    return [...this.awaitMap.values()].filter((a) => a.taskId === taskId).map((a) => ({ ...a }));
  }

  async pendingAwaits(taskId: string, kind?: AwaitKind): Promise<AwaitPoint[]> {
    return [...this.awaitMap.values()]
      .filter((a) => a.taskId === taskId && a.status === "PENDING" && (kind === undefined || a.kind === kind))
      .map((a) => ({ ...a }));
  }

  async resolveAwait(id: string, at: number, events?: readonly TaskEventInput[]): Promise<AwaitResolveOutcome> {
    const found = this.awaitMap.get(id);
    if (found === undefined) return "invalid";
    if (found.status === "RESOLVED") return "already-resolved";
    if (found.status !== "PENDING") return "invalid";
    this.awaitMap.set(id, { ...found, status: "RESOLVED", resolvedAt: at });
    this.pushEvents(found.taskId, events);
    return "resolved";
  }

  async linkEffect(link: TaskEffectLink, events?: readonly TaskEventInput[]): Promise<void> {
    if (!this.effectLinks.some((l) => l.taskId === link.taskId && l.effectId === link.effectId)) {
      this.effectLinks.push({ ...link });
    }
    this.pushEvents(link.taskId, events);
  }

  async taskEffects(taskId: string): Promise<TaskEffectLink[]> {
    return this.effectLinks.filter((l) => l.taskId === taskId).map((l) => ({ ...l }));
  }

  async linkArtifact(link: TaskArtifactLink, events?: readonly TaskEventInput[]): Promise<void> {
    if (!this.artifactLinks.some((l) => l.taskId === link.taskId && l.artifactId === link.artifactId)) {
      this.artifactLinks.push({ ...link });
    }
    this.pushEvents(link.taskId, events);
  }

  async taskArtifacts(taskId: string): Promise<TaskArtifactLink[]> {
    return this.artifactLinks.filter((l) => l.taskId === taskId).map((l) => ({ ...l }));
  }

  async taskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.events.filter((e) => e.taskId === taskId).map((e) => ({ ...e }));
  }
}

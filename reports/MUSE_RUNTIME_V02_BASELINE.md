# MUSE_RUNTIME_V02 — Reality Audit (Baseline)

审计对象：`main` @ 934d5db（clone 后 `git status` 干净）。
环境：Node v24.19.0，pnpm 10.33.0（`corepack prepare pnpm@10.33.0 --activate`），
`pi` 0.87.0 经 `packages/adapter-pi/node_modules/.bin` 加入 PATH（与 CI 一致）。

## Baseline check

```text
command : pnpm check   # pnpm typecheck && pnpm test
exit    : 0
tests   : 206 pass / 0 fail
          epistemic 8 · core 40 · artifact-fs 12 · storage-sqlite 35 · cli 49 · mcp 55 · adapter-pi 7
```

注意：`corepack pnpm check` 在本机失败 —— corepack 不切换版本且把脚本内的
`pnpm` 解析成 v11.21.0（pnpm 自检 `packageManager` 字段拒绝运行）。直接
`pnpm check`（shim 读 packageManager）正常。这是环境工具差异，不是仓库缺陷。

## 可复用什么（代码事实，非文档声称）

- `packages/core`
  - `runEffect`（`src/effect.ts`）：PREPARED→SUBMITTED→CONFIRMED/FAILED/UNKNOWN
    状态机 + `EffectNeedsReconciliationError` + `AmbiguousEffectError` +
    `ReconcileOutcome` 端口 + crash 注入缝。v0.2 直接复用，不建第二套 effect。
  - `evaluateCapabilities` / `ActivationDecision`（`src/capabilities.ts`）：
    REQUIRED 缺失 → BLOCKED。用作 resume gate 的 capability 段。
  - `runDoctor` / probes（`src/doctor.ts`）：环境探针模型。
  - `stableStringify` / `hashRequest`：effect key 规范化。
- `packages/storage-sqlite`
  - `SqliteEffectJournal`（`src/journal.ts`）：WAL + FULL，行更新与
    `relay_effect_events` 同事务提交；transition 守卫拒绝非法迁移。
    `replaceAll` 支持 capsule 导入。`SqliteEffectJournalReader` 只读证据口。
  - `SqliteEpistemicStore`（`src/epistemic-store.ts`）：Investigation/Claim/
    Evidence/Belief/Delta/Decision 六表持久化，close/reopen 可重建。
  - `probeSqliteStorage`：doctor 探针。
- `packages/artifact-fs`：`ArtifactStore` — CAS objects + 原子 rename 记录 +
  parents lineage + `verify()` 完整性检查 + `gcTemp`。
- `packages/epistemic`：`recordEvidence`（唯一 belief/delta 变更路径，
  “No Delta, No Attention” 派生视图）+ `computeDelta` 纯函数 + Memory store。
- `packages/adapter-pi`：Pi extension（`relay:doctor`）、`discoverDeferred`
  （真实 session JSONL 扫描）、`createMockDeferredProvider` /
  `mockDeferredModel`（native Provider/DeferredHandle）、测试已证明
  `createAgentSession` + `SessionManager` + `ModelRuntime.fetchDeferred`
  跨进程 resume 真实可用。
- `packages/cli`：`relay doctor|artifacts|lineage|effects|export|import|status`
  的参数解析模式（`parseXArgs` + `usageError` + exit 语义）可直接扩展 `task` 子命令。
- `packages/mcp`：单写者 workspace 锁 + configured-actions-only 的安全形状。

## 缺什么（v0.2 最小新增面）

1. DurableTask 实体 + TaskStore 端口（core 定义端口，SQLite 实现复用同一
   `.relay/storage.db`、独立 `relay_task_*` 表）。
2. AwaitPoint（USER/APPROVAL/RECONCILIATION 真实实现；TIME/EXTERNAL 仅
   schema seam）+ TaskEvent 追加表（派生，不叙述）。
3. Resume gate（固定顺序：task → capabilities → unresolved effects →
   unresolved awaits → adapter.resume）与恢复协议 5 条强制规则。
4. Effect Decision 层（ALLOW/ASK/DENY）：审批 await 与 effect key 关联；
   effect key 约定 `task/<taskId>/<name>` 以便重启后自愈 task↔effect 链接。
5. Task↔investigation/artifact 引用与派生 snapshot（goal/status/waitingFor/
   confirmed/unknowns/artifacts/unresolvedEffects）。
6. `AgentAdapter` 端口（attach/inspect/resume）+ adapter-pi 的 Pi 实现
   （session 文件 + DeferredHandle + `fetchDeferred`，不复制 Pi 语义）。
7. CLI：`relay task create|list|show|approve|resume`。
8. `examples/pi-muse/`：真实可执行 vertical slice（run→wait→kill→restart→
   approve→resume→effect once→verify→complete）。

## 已 stale 的文档

- `docs/ARCHITECTURE-CORRECTION.md` 自称“仓库零实现”——写于 starter 时代；
  现实现已完整落地，该文只剩历史价值，不作为架构事实来源。
- `docs/ARCHITECTURE.md` 描述的是旧 starter 设计，与现包结构部分脱节。
- `docs/ROADMAP.md` 止于 v0.1（M0–M5），v0.2 目标以
  `tasks/NEXT_ITERATION_MUSE_RUNTIME_V02.md` 为唯一依据。

## 最小修改面

```text
packages/core/src/task.ts            # 新：domain + ports + TaskRuntime
packages/core/src/index.ts           # 导出 task.ts
packages/storage-sqlite/src/task-store.ts  # 新：SqliteTaskStore
packages/storage-sqlite/src/index.ts # 导出
packages/adapter-pi/src/task-adapter.ts    # 新：PiTaskAdapter
packages/adapter-pi/src/index.ts     # 导出
packages/cli/src/task.ts             # 新：relay task 子命令
packages/cli/src/cli.ts              # 接线
packages/{core,storage-sqlite,cli,adapter-pi}/test/*.test.ts  # AC 测试
examples/pi-muse/{README.md,demo.mjs,fixtures/**}              # 新
tasks/NEXT_ITERATION_MUSE_RUNTIME_V02.md                       # 任务文档
reports/MUSE_RUNTIME_V02_{BASELINE,RESULT}.md                  # 报告
```

不新增 package（按任务文档备选方案：core+storage 内置 Task abstraction，
依赖方向 `@relay/core ← @relay/adapter-pi` 保持不变，零循环风险）。

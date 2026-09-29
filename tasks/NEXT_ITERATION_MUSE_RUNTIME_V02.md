# Relay v0.2 — Muse-style Durable Personal Agent Runtime

## 0. 本轮目标

Relay 从：

> Durable execution continuity components for AI agents

升级为：

> **Durable runtime for long-running personal agents.**

核心体验：

```text
用户交给 Agent 一件事
        ↓
Agent 开始执行
        ↓
可能需要外部操作
        ↓
可能等待用户 / 时间 / 外部结果
        ↓
进程退出 / 机器重启 / 会话结束
        ↓
Relay 保存任务连续性
        ↓
条件满足后恢复原任务
        ↓
不重复危险副作用
        ↓
保留证据、Artifact、判断依据
        ↓
最终完成
```

Pi 是第一参考 Agent，但 Relay 不属于 Pi。

未来目标：

```text
Pi
Codex
Claude Code
OpenClaw
custom agent
      ↓
    Relay
      ↓
Durable Task Runtime
```

---

# 1. 当前仓库基线

不要按照旧 starter 重新设计。

当前 `main` 已经具备：

- `packages/adapter-pi`
  - Pi extension
  - Pi capability doctor
  - deferred discovery
  - deferred resume seam
- `packages/storage-sqlite`
  - Effect Journal
  - crash-safe persistence
  - epistemic store
- `packages/artifact-fs`
  - content-addressed artifacts
  - artifact lineage
- Effect Guard
  - PREPARED
  - SUBMITTED
  - CONFIRMED
  - FAILED
  - UNKNOWN
  - reconciliation
- Capability Doctor
- Capsule export/import
- CLI
- MCP entry points
- Codex / Claude Code host integration
- business sandbox
- crash matrix
- Pi deferred migration
- epistemic entities / SQLite persistence
-大量已有验收与独立 review

因此：

**禁止推倒重写。**

本轮应该补的是这些现有能力之上的一层：

```text
              Durable Task
                   │
       ┌───────────┼────────────┐
       ↓           ↓            ↓
     Await      Effect       Evidence
       │         Guard           │
       ↓           │             ↓
    Resume      Artifact     Epistemic
       │
       ↓
 Agent Adapter
       │
       Pi
```

---

# 2. 当前真正缺失的东西

Relay 现在已经能回答：

```text
这个 effect 执行了吗？
这个 artifact 从哪里来的？
环境还能不能 resume？
Pi deferred job 是否需要重新提交？
```

但缺少一个更高层的问题：

> **“用户交给我的这件事，现在到底进行到哪里，为什么停在这里，以及下一步应该在什么条件下继续？”**

这就是 v0.2 的核心。

我们称之为：

# Task Continuity Envelope

Relay 不实现 Agent Loop。

Relay 只维护长期任务跨进程、跨时间所需要的最小连续性状态。

---

# 3. 严格架构边界

## Pi 继续拥有

- agent loop
- model calls
- session tree
- conversation
- tool execution semantics
- suspended run
- DeferredHandle
- model retry
- native resume
- tool replay

## Relay 拥有

- long-running task identity
- task lifecycle
- wait reason
- resume trigger
- external effect safety
- human approval
- artifact references
- capability validation
- epistemic state
- recovery protocol

核心原则：

> Relay orchestrates continuity, not intelligence.

---

# 4. 最小领域模型

不要做 workflow engine。

不要设计 DAG。

不要设计 node graph。

第一版只需要以下模型。

## 4.1 DurableTask

```ts
type TaskStatus =
  | "ACTIVE"
  | "WAITING"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED";

interface DurableTask {
  id: string;

  goal: string;

  status: TaskStatus;

  adapter: "pi";

  agentRef?: {
    sessionId?: string;
    deferredRef?: string;
  };

  investigationId?: string;

  createdAt: number;
  updatedAt: number;
}
```

注意：

`agentRef` 只是引用。

禁止复制 Pi session。

---

# 5. Await 模型

长期 Agent 最重要的不是 run，而是：

> **能正确停下来。**

定义：

```ts
type AwaitKind =
  | "USER"
  | "APPROVAL"
  | "TIME"
  | "EXTERNAL"
  | "RECONCILIATION";

type AwaitStatus =
  | "PENDING"
  | "RESOLVED"
  | "CANCELLED";

interface AwaitPoint {
  id: string;

  taskId: string;

  kind: AwaitKind;

  status: AwaitStatus;

  reason: string;

  createdAt: number;

  resolvedAt?: number;
}
```

v0.2 只必须真正实现：

```text
USER
APPROVAL
RECONCILIATION
```

TIME / EXTERNAL 可以先保留 schema seam，不实现 scheduler。

---

# 6. Task Event

不要把“当前进度描述”当 source of truth。

所有重要状态应来自事实事件。

```ts
type TaskEvent =
  | TASK_CREATED
  | AGENT_ATTACHED
  | WAIT_CREATED
  | WAIT_RESOLVED
  | EFFECT_PREPARED
  | EFFECT_CONFIRMED
  | EFFECT_UNKNOWN
  | ARTIFACT_CREATED
  | EVIDENCE_ADDED
  | TASK_BLOCKED
  | TASK_RESUMED
  | TASK_COMPLETED;
```

任务状态可以由事实推导。

继续遵守现有原则：

> Derived, never narrated.

禁止持久化：

```text
"任务已经完成 70%"
"Agent 基本解决了问题"
"目前进展顺利"
```

这类模型生成的描述不得成为 durable truth。

---

# 7. Recovery Protocol

这是本轮最重要的实现。

恢复任务必须按照固定顺序。

```text
load task
   ↓
validate task status
   ↓
Capability Doctor
   ↓
inspect unresolved effects
   ↓
UNKNOWN?
 ┌─yes─────────────┐
 ↓                 │
RECONCILE           │
 ↓                 │
resolved?           │
 ↓                 │
inspect AwaitPoint ←┘
   ↓
await unresolved?
   ↓
STOP
   ↓ resolved
load agentRef
   ↓
adapter.resume()
   ↓
continue
```

## 强制规则

### Rule 1

存在 UNKNOWN effect：

```text
绝不直接重新执行 effect。
```

必须 reconciliation。

### Rule 2

存在 unresolved approval：

```text
绝不恢复到危险操作之后。
```

### Rule 3

required capability drift：

```text
Task → BLOCKED
```

不得让模型自己“想办法绕过”。

### Rule 4

同一个 wait 被 resolve 两次：

第二次必须成为 no-op / already-resolved。

### Rule 5

同一个 resume 被调用两次：

不得因此重复外部 effect。

---

# 8. Approval / Effect Guard

不要现在复制 Meta Sentinel。

v0.2 只实现非常小的 Effect Decision Layer。

```ts
type EffectDecision =
  | "ALLOW"
  | "ASK"
  | "DENY";
```

第一版 policy 可以非常简单：

```text
read-only operation
        ↓
ALLOW

configured safe idempotent action
        ↓
ALLOW

external mutation requiring human approval
        ↓
ASK

UNKNOWN prior outcome
        ↓
DENY execution
        ↓
RECONCILIATION
```

重要：

Effect Guard 必须继续作为真正的执行边界。

不能变成：

```text
system prompt:
"请记得发邮件之前问我。"
```

---

# 9. Epistemic State

当前 Relay 已经有 epistemic persistence。

不要再创建大型 Knowledge Graph。

v0.2 的目标只是让 Task 能引用已有 epistemic state。

关系：

```text
DurableTask
     │
     └── investigationId
               │
               ├── Claim
               ├── Evidence
               ├── Belief
               ├── Delta
               └── Decision
```

这样恢复任务的时候，不只是：

```text
之前做到 step 4。
```

而是可以恢复：

```text
Goal:
发布 package

Known:
测试通过

Evidence:
artifact:test-report

Unknown:
npm publish 是否真正提交成功

Decision:
需要用户授权发布

Next:
等待 approval
```

这才是 Relay 与普通 checkpoint/runtime 的关键差别。

---

# 10. Artifact Integration

不要复制 Artifact 系统。

直接复用现有 artifact registry。

Task 只建立引用：

```text
Task
 ├─ input artifacts
 ├─ generated artifacts
 └─ evidence artifacts
```

例如：

```text
task-123

artifact:
test-results.json
        ↓
release-package.tgz
        ↓
publish-result.json
```

必须保持 lineage。

---

# 11. Pi Adapter

Pi 是 v0.2 唯一必须跑通的 Agent。

但 Task Runtime 不允许 import Pi。

依赖方向：

```text
@relay/core
      ↑
@relay/task-runtime
      ↑
@relay/adapter-pi
```

或者如果新增 package 没有明显价值：

直接在现有 core + storage 中加入 Task abstraction。

**不要为了架构漂亮新增大量 package。**

Pi adapter 负责：

```ts
interface AgentAdapter {
  attach(...): Promise<AgentRef>;

  inspect(...): Promise<AgentState>;

  resume(...): Promise<ResumeResult>;
}
```

第一版只需要 Pi implementation。

---

# 12. Killer Vertical Slice

不要先做 API 大全。

先完成唯一一个完整场景。

## Scenario：Release Assistant

用户：

```text
帮我检查这个 package。
如果测试通过，准备发布。
真正执行 publish 前必须让我确认。
确认后继续。
```

流程：

```text
Task CREATED
     ↓
Pi 检查 package
     ↓
run tests
     ↓
Artifact 保存 test evidence
     ↓
Claim:
"release candidate passes tests"
     ↓
准备 publish
     ↓
Effect Guard = ASK
     ↓
Task WAITING
     ↓
Await(APPROVAL)
     ↓

────────── kill process ──────────

重新启动 Relay
     ↓
task show
     ↓
仍然 WAITING
     ↓
用户 approve
     ↓
Await RESOLVED
     ↓
Capability Doctor
     ↓
effect journal inspection
     ↓
Pi resume
     ↓
publish
     ↓
CONFIRMED
     ↓
Artifact 保存结果
     ↓
Task COMPLETED
```

第一版 publish 可以使用本地可观察 HTTP provider。

要求：

```text
remote mutation counter == 1
```

必须证明：

- 等待期间退出进程没问题；
- restart 后还知道原任务；
- double approve 不重复；
- double resume 不重复；
- crash after remote commit 不盲重试；
- evidence 不丢；
- artifact lineage 不丢。

---

# 13. Pi-Muse

不要新建 `pi-muse` 主项目。

增加：

```text
examples/pi-muse/
```

它只是：

> Relay + Pi 的 reference application。

目录保持极小：

```text
examples/pi-muse/
├── README.md
├── demo.mjs
└── fixtures/
```

运行体验最终应该接近：

```bash
relay task run \
  --agent pi \
  "检查当前 package，测试通过后准备发布，发布前让我确认"
```

然后：

```bash
relay task list
relay task show <task-id>
relay task approve <task-id>
relay task resume <task-id>
```

CLI 名称可根据现有结构调整，但 UX 应保持这种简单程度。

---

# 14. 本轮明确不做

这是非常重要的 scope gate。

## 禁止实现

- Web UI
- React UI
- 手机 App
- 飞书接入
- WhatsApp
- Browser Computer
- VM
- sandbox OS
- multi-agent swarm
- model router
- 自己的 Agent Loop
- workflow DAG
- BPMN
- Temporal clone
- scheduler framework
- cron platform
- generic event bus
- Redis
- Postgres
- Kafka
- Knowledge Graph
- vector DB
- 大型 memory system
- connector marketplace
- Meta Sentinel 全量复制
- credential proxy
- eBPF security
- generalized plugin runtime

未来可能做。

**本轮一个都不要碰。**

---

# 15. 实施阶段

## Phase 0 — Reality Audit

先检查当前 `main`。

必须确认：

- Effect Journal API
- Artifact API
- epistemic API
- Pi adapter API
- deferred API
- CLI
- MCP
- tests
- package dependency graph

产出：

```text
reports/MUSE_RUNTIME_V02_BASELINE.md
```

只写：

- 可复用什么
- 缺什么
- 哪些文档已经 stale
- 最小修改面

禁止重新写架构论文。

---

# Phase 1 — Durable Task Core

实现：

- DurableTask
- TaskEvent
- SQLite TaskStore
- task create/get/list
- task state transition invariants

验收：

```text
create
↓
close process
↓
reopen DB
↓
get task
↓
state identical
```

不得接 Pi。

---

# Phase 2 — Await / Resume

实现：

- AwaitPoint
- createAwait
- resolveAwait
- resume gate
- restart recovery

完成：

```text
ACTIVE
↓
WAITING
↓
process exit
↓
process restart
↓
WAITING
↓
resolve
↓
ACTIVE
```

测试：

- duplicate resolution
- invalid transition
- resume while pending
- restart persistence

---

# Phase 3 — Effect Guard Integration

把 existing Effect Guard 接入 Task。

Task side effect：

```text
taskId
  ↓
effectId
  ↓
effect journal
```

验证：

### Case A

approval pending → effect 不执行。

### Case B

approve → effect 执行一次。

### Case C

double resume → effect 仍执行一次。

### Case D

remote committed/local unknown → reconciliation。

绝不直接 retry。

---

# Phase 4 — Epistemic + Artifact Link

不要修改 epistemic 核心模型，除非现有 API 真有缺陷。

实现 Task 与：

```text
Investigation
Artifact
Evidence
```

之间的关联。

Recovery snapshot 至少能够得到：

```json
{
  "goal": "...",
  "status": "WAITING",
  "waitingFor": "...",
  "confirmed": [],
  "unknowns": [],
  "artifacts": [],
  "unresolvedEffects": []
}
```

这个 snapshot 必须由 durable facts 推导。

禁止让 LLM生成后直接存成真相。

---

# Phase 5 — Pi Integration

增加 Pi Task Adapter。

目标不是控制 Pi loop。

目标是：

```text
Task Envelope
    ↕
Pi native continuation/session/deferred
```

复用现有 Pi API。

不得：

- 创建 RelaySession；
- 创建 RelayDeferredHandle；
- 实现 Pi replay；
- fork Pi。

---

# Phase 6 — Pi-Muse Reference Demo

实现：

```text
examples/pi-muse
```

完整演示：

```text
run
→ test
→ artifact
→ approval wait
→ kill
→ restart
→ approve
→ resume
→ side effect
→ verify
→ complete
```

Demo 必须是可以真实执行的。

不接受 README-only demo。

---

# 16. Acceptance Matrix

最终至少提供以下自动化测试。

## AC-01 Durable Task

```text
task create
process restart
task reload
```

PASS：ID、goal、status 保持。

## AC-02 Await Persistence

```text
task → WAITING
restart
```

PASS：仍 WAITING。

## AC-03 Premature Resume

存在 pending await 时执行 resume。

PASS：

```text
RESUME_BLOCKED
```

Agent 不执行。

## AC-04 Approval

effect requires approval。

PASS：

approval 之前 remote count = 0。

## AC-05 Resume

approve + resume。

PASS：

remote count = 1。

## AC-06 Double Resume

resume 两次。

PASS：

remote count = 1。

## AC-07 Crash Ambiguity

remote committed，但 Relay 在 confirmation 前 crash。

PASS：

```text
effect = UNKNOWN
```

restart 后：

```text
RECONCILIATION
```

不得直接重新 POST。

## AC-08 Capability Drift

恢复前删除 required capability。

PASS：

```text
Task = BLOCKED
```

## AC-09 Artifact

process restart 后 artifact 可读取且 digest 一致。

## AC-10 Epistemic

Claim / Evidence / Unknown 在 restart 后仍可以恢复。

## AC-11 No Secret Persistence

SQLite / artifacts / logs / capsule 中不得因为本轮实现引入 credential serialization。

## AC-12 Existing Regression

现有：

```bash
corepack pnpm check
```

必须通过。

原有 crash/business/deferred tests 不得回归。

---

# 17. CLI UX

先做最少几个命令：

```bash
relay task create
relay task list
relay task show
relay task resume
relay task approve
```

如果架构允许，最终增加：

```bash
relay run --agent pi "..."
```

但它只是 sugar。

不要为了 CLI 增加复杂框架。

---

# 18. Definition of Done

本轮不是代码合并就结束。

必须全部满足：

- 一个真实 durable task 闭环运行成功；
- 至少发生一次 process restart；
- 至少发生一次 human approval wait；
- side effect 只发生一次；
- evidence 能恢复；
- artifacts 能恢复；
- Pi 使用 native resume/deferred/session 能力；
- existing tests 全绿；
- 新 acceptance tests 全绿；
- 无 Pi fork；
- 无新的 workflow engine；
- 无 UI；
- 无大规模 architecture rewrite。

---

# 19. 最终验收报告

创建：

```text
reports/MUSE_RUNTIME_V02_RESULT.md
```

结构固定：

## Result

PASS / PARTIAL / FAIL

## User-visible capability

一句话说明现在用户能做什么。

## Vertical slice

逐环：

```text
CREATE
RUN
WAIT
KILL
RESTART
APPROVE
RESUME
EFFECT
VERIFY
COMPLETE
```

每项给真实 evidence。

## Tests

列出：

```text
command
exit code
passed
failed
```

## Effect proof

必须明确：

```text
logical effect count
remote request count
remote mutation count
resume count
restart count
```

## Durable proof

列出 restart 前后的：

```text
task id
status
await id
agent ref
effect id
artifact refs
investigation id
```

## Changed files

真实列表。

## Architectural boundary review

确认没有重新实现 Pi。

## Known gaps

只写真实缺口。

## Next milestone

最多 3 项。

---

# 20. 下一阶段，但本轮不要实现

只有 v0.2 PASS 后才讨论：

## v0.3

```text
Timer Await
External Event Await
Webhook wake-up
```

## v0.4

```text
Feishu / email channels
proactive notification
```

## v0.5

```text
Codex Adapter
Claude Code Adapter
OpenClaw Adapter
```

## v0.6

```text
permission policy
credential isolation
stronger sandbox
```

第一性原则：

> **先证明 Agent 能把一件跨时间、跨进程、有人工确认、有副作用的真实事情可靠完成。**

证明不了之前，不继续增加能力。

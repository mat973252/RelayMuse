# 阶段3：真实 Pi 模型与受控任务闭环

验收日期：2026-09-30 Asia/Shanghai。实现与验收：Codex。基线 `86824b5`；分支 `codex/pi-persisted-result-gate-20260930`。本报告随实现提交，不包含个人配置或凭据。

## 结论

**本地受控闭环 PASS**。用户明确批准使用本机已有真实 Pi 模型配置后，实际通过 Pi AgentSession 调用 `aisix/deepseek-v4-flash`，保存并读回正常最终输出。任务等待审批，模拟发布提交后强杀，再由两个新进程竞争恢复；最终完成且只有一次发布请求与一次变更。恢复没有再次请求模型。

这证明本次真实模型及 localhost 合成发布场景。真实发布服务、生产安全、外部采用、跨机真实 provider 恢复和新提交的 GitHub hosted CI 均未证明。没有恢复 Devin 计费会话、增加预算、推送或发布 npm。

## 需求与最小实现

沿用 `tasks/RELAYMUSE_STAGE3_REAL_PI.md` 的既定需求，以及[前一轮记录](PI_PERSISTED_RESULT_GATE_2026-09-30.md)已复核的社区协议讨论。该讨论是需求线索，不是项目采用证据。本次补足“同步模型已完成，重新打开进程还能拿到同一结果并继续”的实际任务；不扩 UI 或平台。

- PiTaskAdapter 支持注入公共 `ModelRuntime`，不再要求调用方注册 mock provider。同步恢复仅需 session 引用，不加载模型或凭据；native deferred 路径保持原有行为。
- `textOnly` 使用公开 SettingsManager/DefaultResourceLoader/AgentSession：关闭工具、扩展、skills、prompt templates、上下文文件、compaction、cache warming 和自动重试；固定合成 system prompt。prompt 60秒后 abort。
- 新增显式 `--opt-in --approve-fixture` 示例。模型输出必须精确匹配短合成标记，才运行真正的合成 package 测试、保存 artifact 并创建实际 APPROVAL await；模型不能替代测试或审批。
- Pi 请求边界记录模型 ID、结果 hash、stopReason、usage 和调用计数；不记录请求 headers、凭据或 stderr 原文。CLI 子进程80秒后强杀，第二次模型请求被拒绝；不可用配置/调用错误不回退 mock。
- 默认 demo 与 CI 全量测试仍可离线执行。新增离线 HTTP 配置 fixture 的成功/失败闭环与个人上下文、凭据 canary 检查。

## 真实调用与恢复证据

本机实际命令，exit 0：

```powershell
node examples/pi-muse/real-provider-demo.mjs --opt-in --approve-fixture --provider aisix --model deepseek-v4-flash --evidence D:/code/aiproject/_review/relaymuse-20260930/real-provider-proof
```

| 验收项 | 实际结果 |
| --- | --- |
| 完整示例 | PASS，16 checks |
| 模型执行 | 真实 Pi AgentSession；stopReason=stop；`RELAYMUSE_REAL_PROVIDER_OK` 匹配 |
| Pi 侧模型请求 | 1；重启、审批、并发恢复后仍为1 |
| 输出请求上限 | maxTokens=64，重试参数为0，工具数0 |
| SDK usage | input=87、output=72、totalTokens=159 |
| 审批前 | WAITING；提前 resume blocked；publishRequests=0 |
| 重复审批 | resolved-awaits 从1到0 |
| 提交后强杀 | kill-intent 存在、after-kill 不存在、远端 POST=1；unsettled effect留存 |
| 两进程竞争恢复 | 完成、publish CONFIRMED、无 unresolved；TASK_RESUMED=2（崩溃尝试与恢复各1） |
| 终态再次恢复 | already，无新增发布 |
| 模拟发布 | publishRequests=1、mutations=1；deferred submissions=0 |
| session与产物 | session字节/hash不变；receipt→test evidence→package lineage 完整，verify无问题 |
| 实际凭据扫描 | 已在内存解析当前凭据；本次证据16个文件逐字节检查，matches=0 |

**费用限制**：请求64不等于实际72输出 token的硬上限；SDK usage只作本次报告，未核验网关/上游如何执行限制，也未获取计费账单。配置cost=0不能证明免费。Pi侧请求1次不证明网关/上游内部没有重试。

本机原始证据在 `_review/relaymuse-20260930/real-provider-proof`；摘要 `result.json`，另有等待、崩溃、完成快照、模型计数、原session与产物。实际凭据值只在内存参与扫描，扫描结果 `real-credential-scan.json` 不含秘密。目录及完整原始日志不提交仓库。扫描只证明本次匹配值未出现，不证明任意opaque bytes都无秘密。

## 负路径与回归

离线 HTTP fixture 是配置/provider 回归，不是真实模型：成功路径实际模型端 HTTP请求1次、模拟发布1次；HTTP400失败路径模型端请求1次、不重试，task=BLOCKED，无APPROVAL、无artifact、publish=0。缺少显式opt-in或fixture批准参数时exit64。canary凭据和个人上下文不出现在留存证据；项目扩展未加载，模型输入无工具与context canary。

本机不可用模型探针 `--provider relaymuse-unavailable-fixture --model unavailable` 实际exit1，模拟发布/变更=0，无mock fallback。attach在建立agentRef前失败，任务留在ACTIVE且没有await/artifact；不是成功或可继续的验收结果。

前一轮同步stop/error/aborted/length/toolUse、空文本、损坏/缺失session、当前分支与context edit回归继续通过；native deferred回归继续通过。deferred错误分类与完成结果写回未扩展，不将同步结果保证泛化到所有provider。

## 平台矩阵

所有环境均为本机执行，pnpm10.33.0，锁定依赖；Linux使用WSL Ubuntu独立clone及本轮精确staged代码patch，未携带本机Pi配置。真实模型调用仅在Windows Node24.13.0执行；各平台全量测试使用离线fixtures。

| 平台 / Node | 命令 | exit | tests / pass / fail / skip |
| --- | --- | --- | --- |
| Windows / 24.13.0 | `npx --yes pnpm@10.33.0 check` | 0 | 291 / 289 / 0 / 2 |
| Windows / 22.23.3 | `npx --yes --package=node@22 --package=pnpm@10.33.0 -c "node --version && pnpm check"` | 0 | 291 / 289 / 0 / 2 |
| Linux / 22.18.0 | `corepack pnpm check` | 0 | 291 / 291 / 0 / 0 |
| Linux / 24.21.0 首次 | `npx --yes --package=node@24 --package=pnpm@10.33.0 -c "node --version && pnpm check"` | 1 | 291 / 290 / 1 / 0 |
| Linux / 24.21.0 全量重跑，同代码 | 同上 | 0 | 291 / 291 / 0 / 0 |

Windows两项skip均为既有符号链接权限测试。`check`含TypeScript构建与所有包测试。Windows与Linux Node24默认demo均exit0、41/41，两任务模拟发布POST=2、mutation=2。

Linux Node24首次失败是既有 deferred 恢复用例 `attach persists agentRef; a fresh adapter resumes the deferred run`：40次轮询后resumed=false，未如期completed；新增真实配置闭环测试通过。相同代码单独重跑该文件12/12通过，全量重跑291/291通过。未定位首次失败根因，未作猜测性修复；这是保留的稳定性疑点，不宣称已修好或每次都稳定通过。

日志在 `_review/relaymuse-20260930/stage3-{win22,win24,linux22,linux24}-check.log`、`stage3-linux24-targeted.log`、`stage3-linux24-recheck.log` 与 `stage3-default-demo.log` / `stage3-linux-default-demo.log`。Linux代码patch SHA-256：`4506622925325626d4ea98af13e97ab2ac2c97b8cd94aaee89046ea74271dbc1`。本轮未推送，所以不是GitHub CI结果；既有workflow运行`pnpm check`会包含新增离线测试，不需要CI真实模型凭据。

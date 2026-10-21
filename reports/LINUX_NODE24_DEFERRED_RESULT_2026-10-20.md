# Linux Node24 deferred 偶发排查与修复

日期：2026-10-20，Asia/Shanghai；最终矩阵完成于北京时间 22:45:56。基线 HEAD `eb8a417`，在前面三项修复的未提交工作区上继续。所有修改仍未提交、推送或发布。

## 结论与优先级

1. 原两项 P1（终态/执行并发、deferred 空文本）和 CLI 退出码 P2 保留并通过本轮回归。
2. 本轮复现了历史同名用例的同症状失败，定位并修复本地 job fixture 的墙上时钟依赖。默认示例随后暴露同一缺陷，release fixture 一并修复。
3. 同一路径还确认一个独立 P2：SDK error/aborted/length/toolUse 被吞成 pending；本轮以失败测试确认并修复。

这是本轮复现的根因，不代表能追溯证明历史那一次必然有相同原因：旧日志只保留 `resumed=false`，没有时钟或 SDK 逐轮结果。没有证据把该问题归为 Node24 或 Pi 本身的固有缺陷。

## 原用例复现与定位证据

目标：`attach persists agentRef; a fresh adapter resumes the deferred run`。WSL Ubuntu 独立目录 `/home/zhaijingzhi/relaymuse-deferred-20261020` 使用当前工作区快照、frozen lockfile 和缓存的 Node24.21.0；旧 Linux 工作区保留。最终 121 个 packages/examples 源文件和根配置逐字节 SHA-256 与 Windows 工作区一致。

- 单独运行 12 次全过；adapter-pi 基线全包 28 项通过，因此没有把一次绿测试当成排除问题。
- 4 进程并发重复 24 次，第 15 次失败：40 次轮询结束后仍 pending，`resumed=false`，与历史同症状。
- 在隔离副本的编译产物临时记录服务耗时和 SDK stopReason，32 次运行有 3 次失败（diagnostic-14/15/16）。三次各 40 轮 SDK 返回全部为 deferred，没有观察到 error。
- 三次服务端最小墙钟耗时分别是 -9314/-9367/-9419ms，最终单调耗时已到 2187/2191/2186ms。job 原本 400ms 即可完成；墙钟回拨使 `Date.now()-submittedAt` 变负，服务持续 pending，超出适配器本轮预算。

上述记录证实墙钟回拨触发本轮失败；回拨的系统来源未定位。临时诊断代码仅在隔离副本，最终构建已重建并确认没有诊断插桩。

修复仅将两处合成任务服务的耗时判断改用 `performance.now()`，保留业务记录的日期时间字段，不增大轮询预算或增加自动重试。默认 Linux 示例首次 39/41，停在崩溃后恢复等待；其 release fixture 有相同 Date.now 耗时写法，修复后示例 41/41。

## 独立错误分类缺陷

Pi 0.87.0 的 `ModelRuntime.fetchDeferred()` 经 `lazyStream` 将部分请求准备异常包装为 `stopReason=error` 的 AssistantMessage。旧 adapter 只认 stop，其他结果全部等待后再 poll，最终将错误误报 pending。

新增 error、aborted、length、toolUse、认证准备异常五项回归，旧代码五项均失败，真实 deferred pending 正例通过。修复为仅 deferred 可继续轮询；其他非 stop 结果立即 failed/resumed=false，无 output、无 continuation、无新任务提交。对外 detail 只含 stopReason，不回传 provider 错误正文；测试使用敏感错误 canary 验证这一点。显式稍后恢复仍使用原 job 引用。

这五项失败是独立确认的缺陷，不是本轮三次时钟失败的原因。

## 测试先行与最终结果

新增共 10 项：两个 fixture 各有时钟回拨和前跳测试（旧实现分别复现失败，最终 4/4）；五项失败分类；一项真实 pending 耗尽后在稍后显式 resume 完成的正例。TaskRuntime 门禁、无 continuation/无重提交、session 字节和 mtime 保持不变均有断言。原失败断言现包含 adapter 结果，避免仅留下 `false !== true`。

修复后的原失败用例以 4 进程并发重复 **48 次，48 次全过**，各次仍断言 submission=1。该重复运行覆盖 job fixture 与 adapter 修复；后续 release fixture 修改另由新增时钟测试、完整矩阵和默认示例覆盖。

| 最终完整 check 环境 | tests | pass | fail | skip | exit |
| --- | --- | --- | --- | --- | --- |
| Linux / Node24.21.0 | 336 | 336 | 0 | 0 | 0 |
| Linux / Node22.18.0 | 336 | 336 | 0 | 0 | 0 |
| Windows / Node24.13.0 | 336 | 334 | 0 | 2 | 0 |
| Windows / Node22.23.3 | 336 | 334 | 0 | 2 | 0 |

各组均使用 pnpm10.33.0，执行 `pnpm check`（typecheck + 全包单元/集成测试）。Windows 两项既有跳过来自 chmod 无法可靠拒绝写入和 symlink 权限条件。adapter-pi 最终 38 项全过；默认 mock 示例 Linux Node24、Windows Node24 均 41/41，两个合成任务各提交与模拟发布一次。`git diff --check` 通过。

过程中的工具环境失败保留：Linux 首次 check 因 pnpm 不在 PATH 未进入测试（记录 0c6343d60532441ab7cdb80a26eecee1）；随后 Node22 初次完整检查因过度收窄 PATH 隐藏 Pi CLI 而失败（cb80376ff1d74bb8a7e8ed66e6be6d71）。修正隔离工具路径后才取得上表结果，没有修改产品逻辑去绕过 doctor。

## 可核验记录

Workbench 四组最终记录读回均 `current_pass=true`，源码和日志哈希 `matched`，命令报告 `source_unchanged=true`。

| 环境 | record_id | 北京时间 |
| --- | --- | --- |
| Windows Node24 | 56b82d4609844d4b8984df1c5aa468ef | 22:40:36–22:42:17 |
| Linux Node22 | 7d356e69ce2d4e4ebe2bb4024bb58e48 | 22:40:36–22:42:31 |
| Linux Node24 | 865ec1faef004849bf73d5e1967d1aff | 22:42:51–22:44:13 |
| Windows Node22 | 644330d7f9a742f2aca9a36b9ac26aa3 | 22:44:18–22:45:56 |

日志位于 `validation/workbench/<record_id>.log`。SHA-256 按上表顺序：

```
4a56022c204fde09654503cacde8ddcdce46e5fedc9664213c504aca613f90b2
2f6588f58b16fd1f72c60076c1c4c51063885a8cbc88b4fbafd5bfe2e3d7d9c1
7d2762343d33d9c84974f383ea45f74bade855e03ef2c861a4c751df04fd96e7
080147109c0d0a4b81d9592291336f752715dcdd73dc9778e891b229539b523c
```

本聊天 work 保留 red/green、矩阵摘要和源码 manifest，以及 `linux-deferred-reproduction-logs.tar.gz`、`linux-deferred-final-logs.tar.gz`，包含首次失败、诊断样本和重复运行证据。中间失败未用最终绿结果覆盖。

## 本轮范围与边界

修改 adapter 的三行失败分类、对应测试和 README，两个 fixture 的单调时钟，新增 `packages/adapter-pi/test/job-server.test.ts` 及本报告；保留前轮改动。没有重写 Pi agent loop、session、DeferredHandle 或工具重放语义。

全部产品验收使用离线 provider/localhost 合成服务。本轮 Pi 只读探索依用户临时规则调用，180 秒超时、无可用结论，已如实回退原生只读探子；该模型委派不属于 RelayMuse 真实 provider 验收。没有启动 Devin、推送或发布；四组本地检查不是公开 CI 或生产稳定性证明。Workbench 本轮核验了记录与哈希，未声称页面展示已验证。

后续顺序：核对远程 CI 与待交付代码的对应关系；真实外部服务验收须明确具体服务及副作用边界。当前评审发现与本轮已确认缺陷已完成修复，没有据未验证假设扩展功能。

# P1 deferred 空文本完成门禁修复

日期：2026-10-20，Asia/Shanghai。基线 HEAD `eb8a4178086e9c1d1c4abee353b41c4fdfdd309a`，在上一轮任务终态/并发修复的未提交工作区上继续。前一轮修改保留；本轮尚未提交、推送或发布。

## 行为与最小修改

`PiTaskAdapter.resume()` 收到 deferred 的 `stopReason=stop` 后，聚合 text 内容并检查 `text.trim().length`。若为零，立即返回 `resumed=false, status=failed`，detail 为 `deferred assistant result is empty`，不返回 output、不继续单次调用内的轮询。

TaskRuntime 通过既有 adapter 失败门禁返回 blocked/adapter，并持久停留 WAITING，禁止 continuation；重复显式 resume 复用原 adapter 等待点。有效非空文本继续返回 completed，保留原始空白和文本分片拼接结果。未改变 Pi 的 agent loop、session 或 DeferredHandle 语义。

生产代码仅新增三行检查，与同步持久结果的非空门禁一致。没有新增抽象、依赖、provider 重试或 session 写入。

## 实际验证

先新增 6 项测试：无内容块、空字符串、纯空白、仅 thinking、空白文本混合 thinking，以及有效文本分片。旧代码 5 个负例全部失败（误报 completed），有效文本正例通过；修复后 6 项全部通过。

负例同时验证：failed/resumed=false、没有 output、每次调用仅一次 fetchDeferred；TaskRuntime 不执行 continuation、不完成任务；重复显式恢复仅保留一个 adapter 等待点；没有新 agent job 提交；session 字节和 mtime 保持不变。正例验证文本原样返回、continuation 正常执行并完成任务。

实际命令与结果：

| 验证 | 环境 | 结果 |
| --- | --- | --- |
| 新增 6 项定向回归 | Windows Node 24.13.0 | 6 通过，0 失败 |
| adapter-pi 全包测试 | Windows Node 22.23.3 | 28 通过，0 失败/跳过 |
| `npx --yes pnpm@10.33.0 check` | Windows Node 24.13.0 | exit 0；316 项、314 通过、0 失败、2 跳过 |
| `git diff --check` | 当前工作区 | 通过 |

Node22 运行：`npx --yes --package=node@22 node --test "packages/adapter-pi/dist/**/*.test.js"`，使用本轮已编译产物。Node24 完整 check 包含 typecheck、单元和集成测试；adapter-pi 28、core 86、storage-sqlite 57、cli 70、mcp 55、artifact-fs 12、epistemic 8。两个既有跳过来自 Windows chmod 和 symlink 权限条件。

全部为离线 provider/localhost 受控测试，没有真实模型或真实发布服务请求。本次未运行 Linux 或 Node22 的全项目 check，旧 Linux Node24 deferred 偶发失败仍未定位，不能将本轮绿色结果视为已解决该问题。

## 验收记录

最终完整 check：22:09:40–22:11:13（北京时间）。Workbench 记录 `523004d563f4498fb099c3e29b63f52d`：passed、exit_code=0、source_unchanged=true；记录读回 current_pass=true，所选源码与日志哈希均 matched。

原始日志：`validation/workbench/523004d563f4498fb099c3e29b63f52d.log`。SHA-256：`98fb8fdef20fef5b2acd50c2da1e9756a950d74406dd18155aa2f008e20bcd10`。

本聊天 work 中另存定向 red/green 与 Node22 日志。工作台 HTTP 验收接口本次仍超时，未确认页面展示。

## 修改范围与后续

本轮修改 `packages/adapter-pi/src/task-adapter.ts`、对应 task-adapter 测试及 adapter README，并新增本报告。CLI WAITING 退出码 P2 尚未修改；没有启动 Devin、恢复 Claude 监测、调用真实模型或进行发布。

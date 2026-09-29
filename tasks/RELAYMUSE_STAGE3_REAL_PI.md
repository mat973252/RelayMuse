# 阶段三：真实 Pi/provider 接入

2026-09-29 23:09 Asia/Shanghai。用户说“继续吧”，延续 Devin 实现、Codex 独立验收的授权。阶段一、二已通过；本阶段尚未派发。

## 已核验的前置条件

- 本机 Pi 0.87.0 的公共 `ModelRuntime` 能加载现有配置。真实合成调用经本机 gateway 到 `aisix/deepseek-v4-flash`，`stopReason=stop`，指定输出 `RELAYMUSE_REAL_PROVIDER_OK`，usage 99 tokens，命令 exit 0。
- 上述仅证明真实模型调用链。SDK usage cost=0 来自配置，不能证明免费，也不是 Relay 完整接入验收。
- `SessionManager.getSessionId()`、`getSessionFile()`、`getLeafEntry()`、`buildSessionProjection()` 是公开 API。当前 adapter 使用私有属性强转和目录首个 JSONL fallback，并把无 deferred 当 idle，尚未验证同步模型结果。
- Devin 原 session 为 suspended；浏览器连接错误导致实际总费用本次无法刷新。最后已核验费用是上午总 USD9.70，扣历史 USD2.57，本轮新增 USD7.13/10，余额 USD2.87；这些是历史值。

## 最小实现范围

1. 支持通过现有 Pi `ModelRuntime` / 本机模型配置接入普通同步 provider，同时保留 native deferred provider 兼容。凭据加载交给 Pi，禁止复制秘密到仓库、提示或产物。
2. 使用公开 session getters，绑定精确 session 文件；禁止选择目录中任意第一个 JSONL。通过公开持久化 session projection 验证当前分支最后 assistant 结果，正常非空最终输出才能报告 completed。error、aborted、空输出、只有 user 或缺失/损坏 session 均不得被当作成功；旧 assistant 成功后新 prompt 失败不能复用旧成功。
3. 同步调用完成后重开进程能读取同一结果，无再次模型调用。deferred 原行为及 pending 门禁保持；人工审批仍绑定实际 request，模型输出不能代替审批或真实 package 测试证据。
4. 新增显式 opt-in 真实 provider 合成示例。模型只生成短文本，不启用工具、扩展、skills、上下文文件加载，不向模型发送仓库/个人配置内容。本地 fixture 是模拟发布 effect，文档必须与真实模型分开说明。
5. 控制调用次数、短输出、超时。无凭据/不可用 provider 明确失败或阻塞；不得自动退回 mock 并宣称真实 provider 成功。默认 demo/CI 仍可离线执行。

## 独立验收

- 同步成功/错误/aborted/空输出/旧成功后失败/多 session 文件互不串用的回归；DB/session 重开保持结果；恢复不再次请求模型。
- 真实本机现有 provider：一次短合成调用，经真实 Pi AgentSession attach 和持久结果读取，而非仅直接 complete API。
- 正常结果后本地 effect 按人工审批完成；模型失败时 continuation=0、POST=0；未审批时 POST=0，批准后 POST=1；恢复和并发不能重复 continuation/effect。
- 原阶段一、二回归与默认 demo；Node22/24 Linux/Windows CI。不向 CI/Devin 提供本机凭据。
- 交付精确 PR head、实际命令/exit、调用计数与未覆盖边界。Devin 自验/CI不代替 Codex 独立验收。

## 派发门禁与停止点

沿用 session `6c6b9852498c4e46b634463199360400`。发任何消息前必须从网页核对实际总费用，并将消息窗口降到当前余额以内的整数金额；余额不足 USD1 或本轮新增达到 USD10 时停止派发。页面无法访问时等待恢复，不用 API ACU=0 推断免费。不得自动加预算、创建新 session、推原 Relay、发布 npm、真实发布/邮件/交易、扩 UI 或平台。网页 SWE-2 High 与 API swe-2-max 差异继续如实记录。

阶段三独立通过后总结、同步 Notion、暂停监控。真实模型预检证据在本机 `_review/relaymuse-20260929/stage3-preflight-result.json`；不提交个人配置或凭据。

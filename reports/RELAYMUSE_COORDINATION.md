# RelayMuse 协调状态

最后核验：2026-09-29 09:04 Asia/Shanghai。

- 用户授权：Devin Cloud 实现；Codex 管进度和独立验收；建立开源 GitHub 项目。
- GitHub：https://github.com/mat973252/RelayMuse；PUBLIC / MIT。
- 本机：D:/code/aiproject/RelayMuse；原 Relay 目录未修改。
- 当前基线：2f8f046fe66675a2abad300c02d700b69e176d71；保留 Relay Git 历史和许可证；实验/PARTIAL。
- 基线 CI：https://github.com/mat973252/RelayMuse/actions/runs/36505744358；最后核验 in_progress，不能当已通过。
- Devin：https://app.devin.ai/sessions/6c6b9852498c4e46b634463199360400；session ID 同 URL；运行中，已确认独立 clone 和阶段 1 先测试后修复。
- 模型：网页已确认 Switched to SWE-2 High；API 仍返回 swe-2-max。保持差异记录，不宣称已一致。
- 预算：网页每次消息后 on-demand 上限 5 美元已保存。历史费用 2.57 美元，本次新增工作总上限 10 美元；消息会重置窗口，必须核对总费用；API ACU=0 不证明免费。不自动提高预算。
- 首阶段任务：tasks/RELAYMUSE_HARDENING_PLAN.md；具体提示保存在本机审查目录 devin-stage1.md。
- 已追加设计约束：人类审批/USER await 必须先于 adapter.resume；只处理 adapter 自己的等待，不能自动解开其他 EXTERNAL await。
- 当前 PR：无。独立验收：未开始，不能把正在实现写成修复完成。
- 跟进自动化：relaymuse-devin，每 15 分钟；无变化不发例行通知。阶段 1/2 都独立通过后暂停。

## 下一步

1. Devin 阶段 1 草稿 PR/精确 commit → Codex 独立审查、Windows 验收及负路径验证；失败具体返工。
2. 阶段 1 通过后派发阶段 2：默认 demo 可运行、真实合成测试证据/lineage、任务单写者锁、并发/崩溃和 CI 矩阵。
3. 不推上游 Relay，不发布 npm 或执行真实 publish/邮件/交易。真实 Pi provider 阶段 3 先核对配置和预算。

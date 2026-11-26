# SPIKE — P0 技术验证

运行环境：deepseek-harness 本仓库 + vitest（mock LLM），2026-11-26。

复现：

```bash
# 把 spike/spike-crew.spec.ts 放到
# packages/experimental/agent-team/tests/ 下，然后：
npx vitest run packages/experimental/agent-team/tests/spike-crew.spec.ts
```

## S1 — 代码能否绕开模型直接驱动任务板？ ✅ 通过

**结论**：可以。插件只要 `inject: ['agents', 'agentTeams']`，用
`ctx.agents.list()` + `ctx.agentTeams.tryMembership(agent)` 就能拿到 Lead 的
live `Agent` 句柄，然后直接 `createTask` / `updateTask(action: 'reassign')`。

**证据**：spec 里没有一次工具调用，任务仍成功派给 `worker`（`ownerName === 'worker'`），
且 DAG 阻塞生效（claim 被拒，错误码 `TEAM_TASK_BLOCKED`）。

**影响**：调度器可以写成确定性代码，不必让 Lead LLM 转达，成本和可预测性都在预期内。

## S2 — 冷恢复（inactive → 唤醒）是否可靠？ ✅ 通过

**结论**：可靠。teammate 被 interrupt 卸载后，`sendMessage` 会把它冷恢复，
并留下带 `source.kind === 'team-message'` 的持久 user 消息（发送者归因完整）。

**证据**：spec 断言复活后 session 日志里恰有一条 peer 消息，正文与发送者均匹配。

**影响**：worker 空闲时可以彻底卸载（零成本），派活时再唤起来，不必常驻。

## S3 — 能否按任务类型在建会话时切权限档？ ✅ 静态确认

**证据**：`packages/webhook/webhook/src/session.ts` 中，
`ctx.permissionPresets.resolve(preset)` 先校验，建档后
`ctx.permissionPresets.set(handle.agent.session, preset)` 落地。

**影响**：权限分档可行。运行时行为待 M1 接入真建会话时复测。

## 遗留

- owner 不自动释放（文档明示）：已用租约机制覆盖，M1 需真实崩溃测试。
- 跨进程 exactly-once 不保证：v1 单进程部署，不做补偿。

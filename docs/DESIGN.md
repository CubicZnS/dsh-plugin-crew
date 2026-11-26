# DESIGN — dsh-plugin-crew

> 版本：P0（地基）。本文件是唯一的架构权威，改动先改这里。

## 1. 一句话

把 DSH 原生 Agent Teams 包成**能跨天无人值守的班组**：代码管队列与生命周期，
LLM 只管拆解、仲裁、验收。

## 2. 决策记录（2026-11-26）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 任务类型 | 代码 / 文献 / 内容 / 数据监控并存 → **任务类型是一等公民** |
| 2 | 宿主 | 一台 Mac 常驻干活，另一台 + 手机远程查看与下发 |
| 3 | 人的介入 | 偶尔在线，**异步批准** |
| 4 | 团队构成 | **混合**：Lead + reviewer 常驻，worker 临时 |
| 5 | 谁当工头 | **混合双脑**：代码管队列，LLM 管拆解/仲裁/验收 |
| 6 | 并发上限 | 4–5 |
| 7 | 验收 | **独立 reviewer 盲审**（只看产物 + rubric） |
| 8 | 权限 | 按任务类型分三档：只读 / 可写 / 可执行 |
| 9 | 写冲突 | **单 writer 租约 + 目录分区** |
| 10 | 预算 | 每日金额上限，超了停 |
| 11 | 批准超时 | **默认拒绝**，任务转 blocked |
| 12 | 任务来源 | 手动 + 手机远程（v1 不接外部事件） |
| 13 | 界面 | DSH 侧边栏面板 + 手机 Remote |
| 14 | 作息 | 有活就干、没活就睡；可延迟任务排谷时 |
| 15 | 分发 | git 仓库，另一台 pull 后安装 |

## 3. 对象模型

见 `schema/`。四个持久对象：

- **task**：要干的活。`todo → claimed → done`，旁路 `blocked` / `failed`。
- **run**：一次执行尝试，绑一个 sessionId。
- **lease**：某个 task 的写权租约，带 `owner` 与 `expiresAt`。
- **inbox**：需要人拍板的事，带选项与超时策略。

### 任务状态机

```
        ┌──────── claim ────────┐
        │                       v
  [todo] ────────────────> [claimed] ── complete ──> [done]
     ^  \                      │  │
     │   \                     │  └── fail ─────────> [failed]
     │    \____ reopen _________│
     │                          └── needs-human ────> [blocked]
     └──────────── resolve ────────────────────────────┘
```

规则：
- `claimed` 必须有**有效租约**（`expiresAt > now`），否则下一个 tick 收尸。
- `blocked` 必须有 `reason`（`blocked` / `needs-human`），且不可被调度。
- 同一 `writeScope` 前缀内，同时最多一个 `claimed`。

### 账本（唯一真源）

append-only JSONL，每行一条记录：

| type | 作用 |
| --- | --- |
| `task.created` / `task.claimed` / `task.released` / `task.completed` / `task.failed` / `task.blocked` | 任务生命周期 |
| `run.started` / `run.finished` | 执行尝试与成本 |
| `lease.renewed` | 续约 |
| `inbox.opened` / `inbox.resolved` | 人工决策 |

折叠（`lib/fold.js`）得到当前状态；**账本永远不重写**，对账靠重放。

## 4. 巡检 tick

每 60s 一次（空闲退避到 5 分钟），六步：

1. **对账 reconcile**：账本 `claimed` ↔ 运行时 roster，找出「账本在跑但 agent 已没」的 run。
2. **收尸 reap**：租约过期的 `claimed` → 释放 + 记 `run.finished(failed)`。
3. **派活 dispatch**：`todo` 且依赖全 done、写域空闲、有并发槽、预算未超 → 唤起 worker。
4. **审计 audit**：`claimed` 但超过 N 分钟无进展 → 催办 / 换人。
5. **判死 deadlock**：无就绪任务、无有效租约、但仍有未完成任务 → 进收件箱。
6. **休眠 idle**：无事可做就什么都不做（零成本）。

## 5. 配置默认值

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `tickMs` | 60000 | 巡检间隔 |
| `idleTickMs` | 300000 | 空闲退避 |
| `leaseTtlMs` | 1800000 | 任务租约 30 分钟 |
| `leaseRenewMs` | 300000 | 续约间隔 |
| `maxConcurrent` | 4 | 并发槽 |
| `maxAttempts` | 2 | 单任务重试上限 |
| `deadlockTicks` | 3 | 连续几个 tick 才判死 |
| `inboxTtlMs` | 14400000 | 收件箱超时 4 小时 |
| `inboxTimeout` | `reject` | 超时默认拒绝 |
| `offPeak` | `00:30–08:30` | 谷时窗口（可配置，不写死定价） |
| `dailyBudget` | 由部署配置 | 每日金额上限 |

## 6. 权限分档

权限挂在**任务类型**上，不挂在 agent 上：

| 类型 | permissionPreset | 允许 |
| --- | --- | --- |
| `code` | 可写 + 可执行 | 改仓库、跑测试 |
| `research` | 只读 + 联网 | 下载与阅读 |
| `content` | 可写指定目录 | 只动产物目录 |
| `monitor` | 只读 | 抓取与告警 |

建会话时通过 `ctx.permissionPresets.set(session, preset)` 落地（SPIKE S3 已验证该 API 存在）。

## 7. 明确不做（v1）

多机共享任务板、git worktree 隔离、外部事件源、定时例行、嵌套团队、实时审批弹窗。

## 8. 已知风险

1. `agent-team` 是 experimental 包，升级即坏 → 所有调用收在 `lib/team.js` 薄适配层。
2. 冷恢复机制可用但语义需持续观察 → 每次 tick 对账兜底。
3. 没有定时任务源时，无人投喂它就空闲 → 不是故障，但价值打折；P3 评估补例行任务。

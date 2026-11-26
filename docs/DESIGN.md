# DESIGN — dsh-plugin-crew

> 版本：P0（地基）。本文件是唯一的架构权威，改动先改这里。

## 0. 术语

- **P = Phase（阶段）**。本仓库与本文档**只用这一套**：P0 地基 / P1 心脏 / P2 班组 / P3 运维 / P4 按需打磨。
- 早期口头讨论里用过 **M（Milestone）**，已废弃。对应关系：M0 → P1 的实跑闸门，M1 → P1，M2 → P2，M3 → P4。

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| P0 | 仓库骨架、决策记录、数据模型、三个技术验证 | ✅ 完成 |
| P1 | 账本、巡检 tick、租约、并发一致性（全用假 agent） | 进行中 |
| P2 | 接 Agent Teams、角色编制、盲审、人工收件箱 | 未开始 |
| P3 | 谷时调度、预算闸、面板、守护、分发 | 未开始 |
| P4 | worktree 隔离、多机、外部事件源（不在承诺范围内） | 未开始 |

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

## 7. P1 实现注记（2026-11-26）

- **重试预算按「真实失败」计**：`task.attempts` 只记录被 claim 过几次（可观测），
  `task.failures` 才消耗 `maxAttempts`。宿主崩溃（`interrupted`）不算任务失败，
  否则一次断电就能把整板任务打进收件箱。
- **单飞 guard**：`tick()` 并发调用会被折叠成一次，配合「派遣前重新折叠状态」，
  同一任务不会被两次派活。
- **id 计数器**：每次 tick 先从折叠状态播种 `run/lease/inbox` 计数器，再本地自增，
  保证同一 tick 内派发多个任务不会 id 撞车。
- **启动对账**：任何 `run.started` 没有对应的 `run.finished`，一律视为被杀的孤儿，
  在派活之前收尾为 `interrupted` 并释放租约。
- **不变量可自证**：`lib/audit.js` 只读账本就能验证「同一任务不存在并发两个 run」，
  daemon 的 summary 与 kill 测试都跑它。

## 8. P2 实现注记（2026-11-26）

- **控制通道 = 工具调用**：worker 结束必须调 `crew_report(run_id, status, summary, artifacts, needs)`。
  调度器只认账本里的 `run.reported`，**不解析自然语言**——这是和 paperclip 最大的差别。
- **盲审在 Executor 内部**：`TeamExecutor` 先派工、等回报；需要评审的类型再派一次 reviewer，
  拿 `review.verdict`。调度器始终不知道 agent、模型、rubric 的存在。
- **驳回复用失败预算**：评审驳回算一次 failed run，第二次驳回即 `blocked` + 收件箱
  （与 `maxAttempts=2` 一致，不另设计数器）。
- **权限档挂在 kind 上**：派活前调 `permissionPresets.set(worker.session, kind.permissionPreset)`；
  worker 不活跃时静默跳过，下次派活重新应用。
- **收件箱超时**：每次 tick 先扫过期项，按 `timeoutAction`（默认 reject）落下
  `blocked(approval-timeout)`，任务不会因为没人回话而永远挂着。
- **适配层可降级**：`lib/team.js` 是唯一 import experimental 服务的文件，全部特征检测；
  没有 Teams 的宿主照样加载其余四个工具。

### P2 明确没做

| 项 | 原因 | 何时 |
| --- | --- | --- |
| 侧边栏面板 | 需要装进正在跑的宿主才能验证，不能替你重启 GUI | P3 与安装一起做 |
| 四类任务真机跑通 | 同上：得在宿主里 spawn 真 teammate | P3 安装后第一件事 |
| 跨会话 memory | 先靠 session 连续性，不做额外记忆层 | 观察后再定 |

## 9. 明确不做（v1）

多机共享任务板、git worktree 隔离、外部事件源、定时例行、嵌套团队、实时审批弹窗。

## 8. 已知风险

1. `agent-team` 是 experimental 包，升级即坏 → 所有调用收在 `lib/team.js` 薄适配层。
2. 冷恢复机制可用但语义需持续观察 → 每次 tick 对账兜底。
3. 没有定时任务源时，无人投喂它就空闲 → 不是故障，但价值打折；P3 评估补例行任务。

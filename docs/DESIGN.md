# DESIGN — dsh-plugin-crew

> 版本：v0.5.0。本文是唯一架构权威；改动先改这里。

## 1. 一句话

插件只做**账本与规矩**。派活不归它管——Lead 会话用 `crew_pull` 领活，用宿主自带的
`subagent` 派出去，worker 用 `crew_report` 回报。插件保证这件事**不会烂尾**。

## 2. 为什么不是「插件自己派活」

在 dsh `0.2.2-rc.5` 上实测：

| 能力 | 实况 |
| --- | --- |
| `ctx.agents` | 只有 `list` / `get`，**只读**，插件无法创建会话 |
| `ctx.agentTeams` | 返回 `TeamService{}`，**一个方法都没有**（空壳） |
| `subagent` / `subagent_fork` | 稳定可用，但只在**模型回合**里可调 |

所以插件没有能力自己拉人干活。硬要试的代价，我们付过了：一次 `TypeError` 让宿主以 1 退出。

## 3. 对象模型

见 `schema/`：**task / run / lease / inbox**。

```
                  crew_pull 认领
  [todo] ──────────────────────> [claimed] ──report succeeded──┐
     ^                               │                         │
     │                               │ report failed           v
     │                               └──────────────> 重试   [review] ──pass──> [done]
     │                                                    │        │
     └──────────────── report failed×N / 超时收尸 ─────────┘        └──fail──> [todo] 或 [blocked]
                                                                              │
                                                                        [blocked] → 收件箱 → 人
```

- `claimed` 必须有**有效租约**（`expiresAt > now`），否则 watchdog 收尸。
- `review` 只由 `crew_pull` 派发（盲审作业），不会被 watchdog 判死锁。
- `blocked` 必须带原因码：`retry-exhausted` / `worker-blocked` / `approval-timeout` / `rejected-by-human`。

## 4. pull 闭环

```
你    → crew_task_add          写进账本（类型决定 rubric 与是否盲审）
Lead  → crew_pull              领到 [{taskId, runId, prompt}]；先评审、后执行
Lead  → subagent(prompt)       原样转发
worker→ crew_report            写 run.reported，同时推进状态
```

`crew_pull` 负责的全部规则：依赖未完成不派、写域冲突不派、`failures >= maxAttempts` 不派、
一次最多 5 个。

**时间窗口不拦 pull。** 0.5.1 起 `crew_pull` 不再因为「不在谷时」而拒发作业——交互式场景里，
人加了活就是要现在干。「夜里跑」应该靠一个定时触发去调 `crew_pull`，而不是在 pull 内部拦截。

`crew_report` 是**唯一**状态推进入口：它同时写 `run.reported` 并追加下一步事件
（`task.completed` / `task.review.requested` / `task.released` / `task.blocked`）。

## 5. watchdog（后台循环，不派活）

每 60s（空闲退避到 5 分钟）：

1. **收件箱过期**：`dueAt` 已过的待批项按 `timeoutAction`（默认 reject）落地。
2. **收尸**：租约过期的 `claimed` → 回 `todo`；若失败次数已耗尽 → `blocked` + 收件箱。
3. **审计**：认领超过 `auditAfterMs` 仍无进展 → 记一条日志。
4. **判死**：还有未完成任务，但没有可领的活、没有在评审、没有活着的认领，且连续
   `deadlockTicks` 轮 → 开一条收件箱。评审中的任务不算卡死。

它**从不**创建 agent、**从不**派活。故障只记日志，不抛给宿主。

## 6. 配置（`~/.dsh/crew/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false`（安装器写 `true`） | 是否启动 watchdog |
| `tickMs` / `idleTickMs` | 60000 / 300000 | 巡检节奏 |
| `leaseTtlMs` | 1800000 | 认领有效期 |
| `maxAttempts` | 2 | 真实失败几次后升级给人 |
| `deadlockTicks` | 3 | 连续几轮判死 |
| `auditAfterMs` | 900000 | 多久算「没进展」 |
| `inboxTtlMs` / `inboxTimeout` | 4h / `reject` | 收件箱超时策略 |
| `offPeak` | `00:30–08:30` Asia/Shanghai | 仅用于 `crew_status` 显示「当前是否谷时」，不拦任何动作 |
| `dailyBudget` / `costPerMToken` | 未设 | 只用于展示今日花费 |

**没有 `homeWorkspace`。** 班组在哪个工作区干活，由你开 Lead 会话的位置决定；
写域（`src/` 之类）也是相对该会话的 cwd。这是刻意的：一套工具服务多个项目，不绑目录。

## 7. 任务类型

| 类型 | 默认写域 | 需盲审 | rubric 关注点 |
| --- | --- | --- | --- |
| `code` | `src/` | 是 | 改动范围、测试、无残留调试代码 |
| `research` | `docs/` | 是 | 来源可追溯、不把摘要当全文 |
| `content` | `content/` | 是 | 受众语气、结构与首段 |
| `monitor` | `data/` | 否 | 口径写清、阈值有依据 |

「只读 / 可写 / 可执行」的权限档目前体现为**写域约束与 rubric**，没有接宿主的 permission preset——
插件层拿不到建会话时机。要真正硬隔离，得在 Lead 会话层面用 preset。

## 8. 版本教训（别再踩）

1. **别在 experimental 包上下注。** Agent Teams 的包与 dsh 0.2.2-rc.5 对不上，服务是空壳。
2. **插件提供的服务出问题会崩宿主。** 所以本插件的 `cordis.patch.yml` 只挂载自己。
3. **`dsh` CLI 会重写 `dsh.profile.bundles`。** 校验要看文件，不要用 `--dump-config`（它本身是写操作）。
4. **认错 profile 要付三次重启。** 装之前先确认宿主进程用的是 web 还是 desktop。

## 8.7 面板（v0.6.0）

两种形态共用一份数据折叠（`lib/panel.js` 的 `buildPanelData`）：

```
账本 → buildPanelData → {tasks[].runs[].prompt/summary, inbox, stats}
        ├── 侧边栏面板：host 注册 /api/crewPanel → 客户端 5s 轮询
        └── 离线 HTML：bin/crew-report.mjs 渲染成单文件
```

侧边栏是**客户端插件**：手写 UMD（`window.__ModuleLoader__.load`），不构建、不打包，
注册到 `conversation.view` 槽位。刻意包了 error boundary——面板崩了不能连累对话。

## 9. 不做

嵌套团队、多机共享账本、worktree 隔离、外部事件源（webhook/邮件）、实时审批弹窗、
侧边栏 UI 面板。这些不是能力不足，是当前阶段做了也验证不了。

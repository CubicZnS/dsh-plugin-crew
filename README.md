# dsh-plugin-crew

在 DSH 里跑**无人值守班组**：一个常驻 Lead + 临时 worker + 盲审 reviewer，
任务板驱动，崩溃能自愈，需要人时进收件箱。

> 状态：**v0.4.0（pull 模型）**。插件只记账与定规矩，派活交给 Lead 会话用宿主自带的
> `subagent`。零 experimental 依赖，35 条单测全绿。

## 三步装好

```bash
git clone https://github.com/CubicZnS/dsh-plugin-crew.git
cd dsh-plugin-crew && ./install.sh
# 重启 DSH，然后在对话里说：crew_status
```

给 agent 装可以用 `./install.sh --json`，判断规则写在 [AGENTS.md](AGENTS.md)。
> 设计见 [docs/DESIGN.md](docs/DESIGN.md)，验证结论见 [docs/SPIKE.md](docs/SPIKE.md)。

## 它解决什么

DSH 原生 Agent Teams 已经提供了 roster / 持久信箱 / 任务板 / 冷恢复，
但它们假设"有人在看着"。本插件补的是**运行层**：

| 缺口 | 本插件的做法 |
| --- | --- |
| 任务 owner 永不释放 | 租约 + 收尸（lease / reap） |
| 宿主重启后状态不明 | 启动对账（reconcile） |
| 没人看警告 | 死锁判定 / 老化告警 |
| 需要人决策时会卡死 | 人工收件箱 + 超时默认拒绝 |
| 花钱没闸门 | 每日预算 + 谷时调度 |

## 工具面

| 工具 | 谁用 | 作用 |
| --- | --- | --- |
| `crew_task_add` | 人 | 往任务板加活 |
| `crew_pull` | **Lead** | 领活：返回带完整提示词、可直接丢给 `subagent` 的作业 |
| `crew_report` | **worker / reviewer** | 唯一的完成信号，同时推进任务状态 |
| `crew_tasks` | 人/Lead | 任务板明细（含尝试/失败次数） |
| `crew_status` | 人/Lead | 总览：还有什么活、收件箱、今日花费 |
| `crew_inbox` | 人 | 列出待拍板项，或给结论 |
| `crew_plan` | 人/Lead | 空跑一次巡检，看 watchdog 会做什么 |

## 它怎么跑起来

```
你    → crew_task_add          把活写进账本
Lead  → crew_pull              领到 {taskId, runId, prompt}
Lead  → subagent(prompt)       派给子会话干活
worker→ crew_report            回报，同时推进状态
账本  → done / review（盲审）/ todo（重试）/ blocked（进收件箱）
```

插件**不创建任何 agent**——在这台机器的 dsh 上 `ctx.agents` 是只读的。它只负责
「谁该干什么、干到哪一步、什么时候该问人」。

## 前置条件

1. **不需要 Agent Teams。** 0.4.0 起不再安装任何 experimental bundle，也就不需要版本豁免。
2. **建议专用工作区**，默认 `~/crew-work`，在 `~/.dsh/crew/config.json` 的 `homeWorkspace` 改。
3. **一次重启。** 宿主侧插件要重新载入才生效，没有热插拔。

## 安装（干活那台 Mac）

```bash
git clone <repo> ~/dsh-plugin-crew
cd ~/dsh-plugin-crew
dsh plugin --profile web add .
```

然后重启宿主进程（DSH 菜单 → Restart Harness）。看板出现在侧边栏「班组」。

## 开发

```bash
npm test                      # 27 条单测，不需要 DSH
node bin/crew-daemon.mjs --tasks 3 --work 500 --ticks 20   # 空跑一个模拟班组
node bin/crew-report.mjs --ledger ./.crew/ledger.jsonl --out ./.crew/report.html
./scripts/kill-test.sh        # 崩溃自愈验收：kill -9 后重启，任务全完成且不变量成立
```

跨仓库的集成验证见 [spike/](spike/)：那套 spec 要放在 deepseek-harness 仓库里跑。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：巡检 tick、工具、RPC |
| `lib/ledger.js` | append-only JSONL 账本 |
| `lib/fold.js` | 账本折叠成当前状态 |
| `lib/plan.js` | 纯函数：下一个 tick 该做什么 |
| `lib/client.js` | 侧边栏面板（P0 占位） |
| `schema/` | task / run / lease / inbox 的 JSON Schema |
| `docs/DESIGN.md` | 决策记录、状态机、配置默认值 |
| `docs/SPIKE.md` | P0 三个技术验证的结论与证据 |

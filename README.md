# dsh-plugin-crew

在 DSH 里跑**无人值守班组**：一个常驻 Lead + 临时 worker + 盲审 reviewer，
任务板驱动，崩溃能自愈，需要人时进收件箱。

> 状态：**P2（班组）**。调度器 + Agent Teams 接入 + 盲审 + 收件箱已实现，
> 27 条单测覆盖；真机跑通与侧边栏面板在 P3 随安装一起验证。
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
| `crew_status` | 人/Lead | 各状态任务数、租约、收件箱、下一 tick 动作 |
| `crew_tasks` | 人/Lead | 任务板明细（含尝试/失败次数） |
| `crew_plan` | 人/Lead | 空跑一次巡检，看会触发什么 |
| `crew_report` | **worker / reviewer** | 唯一的完成信号，写进账本 |
| `crew_inbox` | 人 | 列出待拍板项，或给结论 |

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

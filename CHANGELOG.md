# CHANGELOG

## 0.1.0 — P1 心脏（2026-11-26）

- `lib/scheduler.js`：单飞 tick、启动对账、收尸、派活、审计、判死、空闲退避
- `lib/executor.js`：Executor seam + StubExecutor + ControlledExecutor（P2 换真 worker 不动调度器）
- `lib/audit.js`：账本不变量（同一任务不得并发两个 run）
- 重试预算改为按真实失败计：崩溃中断不消耗重试次数
- 工具：新增 `crew_tasks`
- CLI：`bin/crew-daemon.mjs`（可打断的 tick runner）、`bin/crew-report.mjs`（自包含 HTML 面板 v0）
- 验收：`scripts/kill-test.sh` —— kill -9 后重启，3/3 任务完成、租约清零、不变量 OK
- 单测 13 条全绿

## 0.0.1 — P0 地基（2026-11-26）

- 仓库骨架、`cordis.patch.yml`、`dsh` 包声明
- 纯逻辑核心：`lib/ledger.js`（JSONL 账本）、`lib/fold.js`（状态折叠）、`lib/plan.js`（tick 规划）
- 只读工具：`crew_status`、`crew_plan`
- 数据模型：`schema/{task,run,lease,inbox}.schema.json`
- 设计文档 `docs/DESIGN.md`、验证记录 `docs/SPIKE.md`
- 单测 7 条全绿；S1/S2 spike 在 deepseek-harness 运行时中通过

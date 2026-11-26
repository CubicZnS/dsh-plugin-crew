# CHANGELOG

## 0.0.1 — P0 地基（2026-11-26）

- 仓库骨架、`cordis.patch.yml`、`dsh` 包声明
- 纯逻辑核心：`lib/ledger.js`（JSONL 账本）、`lib/fold.js`（状态折叠）、`lib/plan.js`（tick 规划）
- 只读工具：`crew_status`、`crew_plan`
- 数据模型：`schema/{task,run,lease,inbox}.schema.json`
- 设计文档 `docs/DESIGN.md`、验证记录 `docs/SPIKE.md`
- 单测 7 条全绿；S1/S2 spike 在 deepseek-harness 运行时中通过

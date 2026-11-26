# CHANGELOG

## 0.3.0 — P3 可部署（2026-11-26）

- `install.mjs` / `install.sh`：幂等部署，探测 App/CLI/profile，补 Agent Teams bundle，装插件，
  `--dump-config` 验证，写 config/deploy 记录；支持 `--json` `--dry-run` `--restart` `--accept-risk`
- 版本对齐：按 dsh 主次版本挑选已发布的 Team bundle；不匹配时报 `E_RISK_REQUIRED` 并交出命令原文
- `bin/crew-doctor.mjs`：11 项静态检查 + 修复建议
- `AGENTS.md`：给 coding agent 的部署手册（含失败码分支、要不要重启的判断）
- 谷时调度：可延迟任务排在便宜时段，急活/临近 deadline 不受限
- 预算闸：按当日 token × 单价计算，超限停派活并开收件箱
- 服务解析改为 `ctx.get()` + `ctx.inject()` 延迟启动，修复真机启动时 `without inject` 崩溃
- 单测 33 条全绿；在独立 profile 上用真实宿主验证 scheduler 启动

## 0.2.0 — P2 班组（2026-11-26）

- `lib/team.js`：Agent Teams 薄适配层（发现 Lead、spawn/复用 teammate、投递、按 kind 设权限档），特征检测可降级
- `lib/team-executor.js`：真实 Executor —— 派 handoff → 等 `crew_report` → 盲审 → 判定；超时/取消可收口
- `lib/kinds.js`：任务类型注册表（权限档、默认写域、rubric、交付形态、是否评审）
- 工具：`crew_report`（worker 唯一完成信号）、`crew_inbox`（人工拍板）
- 收件箱超时：tick 扫描过期项，按 timeoutAction（默认 reject）落 blocked(approval-timeout)
- 插件在 `enabled: true` 且检测到 live Team 时自启调度循环，随 ctx 卸载停止
- 单测 27 条全绿

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

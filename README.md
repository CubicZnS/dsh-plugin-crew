# dsh-plugin-crew

给你一个**能记账、能派活、不会烂尾**的 agent 班组：任务板 + 租约 + 盲审 + 人工收件箱。

> 状态：**v0.5.0**。插件不创建 agent——派活由 Lead 会话用宿主的 `subagent` 完成。
> 30 条单测全绿；设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 三步装好

```bash
git clone https://github.com/CubicZnS/dsh-plugin-crew.git
cd dsh-plugin-crew && ./install.sh
# 重启 DSH，然后在对话里说：crew_status
```

给 agent 装可以用 `./install.sh --json`，判断规则写在 [AGENTS.md](AGENTS.md)。

## 它怎么跑

```
你    → crew_task_add          把活写进账本
Lead  → crew_pull              领到 {taskId, runId, prompt}
Lead  → subagent(prompt)       派给子会话干活
worker→ crew_report            回报，同时推进状态
账本  → done / review（盲审）/ todo（重试）/ blocked（进收件箱）
```

**一次对话就能跑完一轮**：

>> 加个任务：把 README 的安装那节改短一点
（模型会 crew_task_add → crew_pull → subagent → crew_report）

## 它替你守住的四件事

| 缺口 | 做法 |
| --- | --- |
| 认领了却不干活 | 租约 + 过期收尸 |
| 干完了没人判 | 独立盲审（只看产物与 rubric） |
| 失败无限重试 | 失败次数上限 → 进收件箱 |
| 全员互相等 | 连续 N 轮无进展 → 判死并叫人 |

## 工具面

| 工具 | 谁用 | 作用 |
| --- | --- | --- |
| `crew_task_add` | 人 | 往任务板加活 |
| `crew_pull` | **Lead** | 领活：返回带完整提示词、可直接丢给 `subagent` 的作业 |
| `crew_report` | **worker / reviewer** | 唯一的完成信号，同时推进任务状态 |
| `crew_task_cancel` | 人 | 取消任务（写墓碑，不删记录） |
| `crew_tasks` | 人/Lead | 任务板明细（含尝试/失败次数） |
| `crew_status` | 人/Lead | 总览：还有什么活、收件箱、今日花费 |
| `crew_inbox` | 人 | 列出待拍板项，或给结论 |
| `crew_plan` | 人/Lead | 空跑一次巡检，看 watchdog 会做什么 |

## 开关（默认关闭）

装完**不会自己动**。第一次使用：打开「班组」面板 → 点「**启用班组**」。

- 关闭时：工具调用一律拒绝（返回「未启用」），后台巡检不启动，账本不写
- 启用时：开始巡检、记账、派活；面板右上角「关闭」可随时关掉
- 开关状态存在 `~/.dsh/crew/config.json` 的 `enabled`，**改完立刻生效，不需要重启**

## 面板

装好后，对话区顶部多一个 **「班组」** 标签（和 Chat / Trajectory 并排）：

- 任务列表：状态、尝试/失败次数
- **群聊样式**：加任务、派活、回报、判决都渲染成气泡（自己的靠右），`@worker` `@reviewer` `@你` 会高亮
- 底部有输入框，你发的话会写进账本，Lead 用 `crew_chat` 就能读到
- 顶部四个数：任务 / 完成 / 阻塞 / 待评审，另有「待拍板」提示
- 每 5 秒自动刷新，也可以手动刷新

数据走宿主的 rpc 桥（`/api` + `crewPanel`），组件出错只会让这个标签显示错误，不影响对话本身。

**离线版**（不依赖宿主，可发人/手机看）：

```bash
node bin/crew-report.mjs --open          # 渲染并打开 HTML
node bin/crew-report.mjs --serve 7788    # 起本地页面，手机同 Wi-Fi 可访问
```

## 前置条件

1. **不需要任何 experimental 包**，也不需要版本豁免。
2. **一次重启**：宿主侧插件要重新载入才生效，没有热插拔。
3. **不绑工作区**：班组在哪干活，取决于你在哪个工作区开 Lead 会话。

## 开发

```bash
npm test                                   # 30 条单测，不需要 DSH
node bin/crew-report.mjs --ledger ~/.dsh/crew/ledger.jsonl --out ./report.html
node bin/crew-doctor.mjs                   # 静态体检
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 七个工具 + watchdog 装配 |
| `lib/ledger.js` / `lib/fold.js` | append-only JSONL 与状态折叠 |
| `lib/plan.js` / `lib/scheduler.js` | watchdog 规划与循环 |
| `lib/handoff.js` / `lib/kinds.js` | 作业提示词与任务类型 |
| `lib/window.js` | 谷时判断与花费统计（只用于展示） |
| `bin/crew-doctor.mjs` / `bin/crew-report.mjs` | 体检与离线报告 |
| `schema/` | 四个对象的 JSON Schema |

## 许可

MIT

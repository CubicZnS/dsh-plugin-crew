# CHANGELOG

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)：
**主版本**改协议或数据格式，**次版本**加功能，**修订号**只修 bug。
每次发版必须同时更新：`package.json` 的 version、本文件、`docs/DESIGN.md` 的对应注记，并打 git tag。

## [0.7.1] — 2026-11-27

### 修复
- **面板布局重做**：根容器改 flex 列（头部 / 可滚动消息区 / 底部输入区），消息区吃掉剩余高度，
  输入框与发送按钮固定在底部——之前输入框挤在空状态下面，按钮也压在一起。
- 视觉分层：头部 15px 标题 + 四个独立状态胶囊（阻塞/待拍板变色）、消息头像、气泡 14px 圆角、
  正文 13.5px/1.65；输入框 44px 高、最大宽 760px 居中，提示文字降到 11px 弱化。
- 空状态改成居中两行（标题 + 引导），不再是贴顶一行大字。

## [0.7.0] — 2026-11-27

### 变更
- **面板改成群聊样式。** 账本里的每条协调事件都投射成一条消息：你加任务、Lead 派活、
  worker 回报、reviewer 判决、系统提醒，都按「谁 → 谁」渲染成气泡；自己的消息靠右。
  `lib/chat.js` 的 `deriveMessages()` 负责投射，不重复存任何内容。
- **支持 @**：消息里写 `@worker` / `@reviewer` / `@你` 会被高亮；派活与盲审消息自动带上 @。

### 新增
- `crew_say`：以某个成员身份发一句话（默认 Lead）。
- `crew_chat`：读聊天记录（可按任务过滤）。
- 面板底部新增输入框：以「你」的身份发消息写进账本，Lead 下次 `crew_chat` 能看到。
  回车发送、Shift+回车换行。

## [0.6.1] — 2026-11-27

### 变更
- **面板里的对话改成摘要视图**：每一轮只显示两行——「派活：任务标题」「回报：一句话结论」，
  提示词原文、summary 全文与文件路径折叠在「原文」里。之前把整段 handoff 和产物路径直接铺开，
  看着像日志而不是对话。
- `crew_report` 新增 `headline` 参数（≤40 字，不写路径）；handoff 与盲审提示词都要求 worker 填。
  老记录没有 headline 时，自动取 summary 的第一句。

## [0.6.0] — 2026-11-27

### 新增
- **侧边栏「班组」面板**（客户端插件）：对话区新增一个 tab，展示任务列表与每个任务的
  **Lead ↔ worker 对话**（handoff 提示词原文 + 回报 summary 与产物），5 秒轮询刷新。
  数据走宿主 rpc 桥（`/api` + `crewPanel`）；组件包了 error boundary，出错只影响这个 tab。
- `lib/panel.js` 拆出 `buildPanelData()`，侧边栏面板与离线 HTML 共用同一份数据折叠逻辑。
- `crew_pull` 把 handoff 提示词写进 `run.started`——否则面板无法显示「Lead 说了什么」。

### 说明
- 客户端插件是手写的无构建模块（`window.__ModuleLoader__.load`），与 dsh-plugin-paper-fetch 同一套接法。
- 离线 HTML 面板保留：手机访问、发给别人、宿主挂掉时都能用；确认侧边栏版够用后再清理。

## [0.5.1] — 2026-11-27

### 修复
- **`crew_pull` 不再因为「不在谷时」拒发作业。** 现场反馈：早上 8:58 加的任务被 00:30–08:30 的窗口
  挡住，要等到半夜才动。交互式使用里这是错的——时间窗口只保留为 `crew_status` 的展示信息，
  「夜里跑」交给定时触发去调 `crew_pull`。
- 首次真机闭环验证：`task.created → claimed → run.started → run.reported → task.completed`，
  worker 子会话成功调用 `crew_report` 并把任务推进到 `done`。

### 新增
- `crew_task_cancel`：写墓碑取消任务；已完成的任务不能取消；已认领的连带释放租约。

## [0.5.0] — 2026-11-27

### 变更（不兼容）
- **删掉「班组绑工作区」的概念。** `config.homeWorkspace` 移除；班组在哪个目录干活，
  由你开 Lead 会话的位置决定。安装器不再创建 `~/crew-work`，`--workspace` 参数一并移除。

### 移除
- `lib/team.js`（Agent Teams 适配层）、`lib/executor.js`（宿主侧执行器）、
  `bin/crew-daemon.mjs`、`scripts/kill-test.sh`、`spike/`、`docs/SPIKE.md`。
- `crew_status` 输出里的 `services` 与 `homeWorkspace` 字段。
- 调度器的派活路径（`dispatch` 动作、`maxConcurrent`、单写者排队）——这些规则搬进 `crew_pull`。

### 新增
- `crew_pull` 现在负责谷时延后：窗口外的可延迟任务不派，返回 `deferred` 列表。
- `plan.js` 收敛为纯 watchdog 规划：收尸 / 审计 / 判死。

### 修复
- 评审中的任务不再被误判为死锁。
- watchdog 的并发调用合并为一次（收尸只做一次）。

### 文档
- DESIGN、README、DEPLOY 全量重写，去掉所有 Agent Teams 与工作区绑定的描述。

## [0.4.0] — 2026-11-27

### 变更（不兼容）
- **派活模型从 push 改为 pull。** 插件不再尝试创建 agent，也不再依赖 Agent Teams 服务；
  `crew_pull` 把带完整提示词的作业交给 Lead 会话，由 Lead 用宿主自带的 `subagent` 派出去。
  原因：本机 dsh 0.2.2-rc.5 上 `ctx.agentTeams` 是空壳（`TeamService{}` 无任何方法），且
  `ctx.agents` 只读，插件无法自行创建会话。
- `crew_report` 现在负责推进状态机：成功 → 评审或完成；失败 → 重试或进收件箱。

### 新增
- `crew_pull`：一次领 N 个作业（先评审、后执行），自动校验依赖、写域冲突、并发上限。
- `lib/handoff.js`：作业提示词生成（executor 与 pull 共用同一套措辞）。
- 任务状态新增 `review`（待盲审）；`review.verdict` 通过则完成、驳回则回退并计一次失败。
- 单测 35 条，覆盖「领活不重复」「盲审通过/驳回」「失败耗尽进收件箱」「依赖与写域」四条主链。

### 移除
- `lib/team-executor.js` 与对应测试：不再有宿主侧 Executor。
- 安装器不再安装 `@deepseek-ai/dsh-experimental-agent-team-profile`，不再需要版本豁免
  （`E_RISK_REQUIRED` 随之废弃）。

### 修复
- 调度器：pull 模式下不再派活，只做收尸/审计/判死（watchdog）。
- 调度器：`executor` 缺省时不再空指针。
- `fold`：`run.reported` 现在计入失败次数（pull 模式没有 `run.finished`）。

## [0.3.1] — 2026-11-26

### 修复
- **宿主崩溃**：`discoverLead` 对 `agentTeams` 做了形状假设，遇到空壳服务抛
  `TypeError: teams.tryMembership is not a function`，未捕获导致宿主以 1 退出。
  现在服务形状不匹配即视为不可用，tick 全程 try/catch，故障只记日志。
- `cordis.patch.yml` 退回「只挂载自己」：不再由本插件提供 Agent Teams 服务。

## [0.3.0] — 2026-11-26

### 新增
- 一条命令部署：`install.sh` / `install.mjs`（幂等、`--json`、`--dry-run`、`--restart`、`--workspace`）。
- `bin/crew-doctor.mjs`：静态体检 + 修复建议。
- `AGENTS.md`：给 coding agent 的部署手册。
- 谷时调度（可延迟任务排到便宜时段）与每日预算闸。

### 修复
- 部署校验不再用 `--dump-config`（它本身会重写 `dsh.profile.bundles`）。

## [0.2.0] — 2026-11-26

### 新增
- Agent Teams 适配层、控制通道 `crew_report`、盲审循环、人工收件箱与超时默认拒绝。
- 任务类型注册表（code / research / content / monitor → 权限档、写域、rubric）。

### 已知问题
- 依赖 experimental Agent Teams 服务；该服务与本机 dsh 版本不匹配。

## [0.1.0] — 2026-11-26

### 新增
- 账本（append-only JSONL）、巡检 tick、租约与收尸、崩溃自愈与不变量自检。
- `bin/crew-daemon.mjs`、`bin/crew-report.mjs`、`scripts/kill-test.sh`。

## [0.0.1] — 2026-11-26

### 新增
- 仓库骨架、决策记录（DESIGN）、四个对象 schema（task / run / lease / inbox）。
- 三个技术验证：插件可绕过模型驱动任务板、冷恢复可用、权限档可在建会话时落地。

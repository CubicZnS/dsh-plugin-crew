/**
 * dsh-plugin-crew — host half.
 *
 * Registers the tool surface and, when deployment config says so and a live Team
 * exists, starts the unattended tick loop for the lifetime of the plugin.
 */
import { join } from 'node:path'
import { Ledger } from './ledger.js'
import { fold } from './fold.js'
import { planTick, DEFAULTS } from './plan.js'
import { Scheduler } from './scheduler.js'
import { TeamAdapter } from './team.js'
import { TeamExecutor } from './team-executor.js'
import { kindOf, listKinds } from './kinds.js'
import { dataDirFor, loadConfig, loadDeployment, resolveConfig, deploymentSummary } from './config.js'
import { tokensToday, isOffPeak } from './window.js'

export const name = 'dsh-plugin-crew'
export const inject = ['tools']

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }

function text(lines) {
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

function countBy(items, pick) {
  const counts = {}
  for (const item of items) counts[pick(item)] = (counts[pick(item)] ?? 0) + 1
  return counts
}

function crewStatusTool(ctxOf) {
  return {
    name: 'crew_status',
    description: '班组总览：部署情况、Team 是否就绪、家在哪、任务/租约/收件箱、今日花费、下一个 tick 会做什么。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(['查询失败：' + (value.error || '未知错误')])
        const tasks = Object.entries(value.tasks).map(([status, count]) => status + '=' + count).join('  ') || '（空）'
        const deployment = value.deployment.deployed
          ? '已部署 ' + value.deployment.version + '（' + value.deployment.profiles.join(', ') + '）'
          : '未部署（跑 install.sh 或看 docs/DEPLOY.md）'
        return text([
          '部署：' + deployment,
          'Team：' + (value.team.available ? '就绪，' + value.team.members.length + ' 名成员' : '不可用（缺 agent-team bundle 或没有 live 会话）'),
          '家：' + (value.team.home ?? '未绑定（会退化为最新会话）'),
          '调度：' + (value.config.enabled ? '已开启' : '未开启') + '　谷时：' + (value.config.offPeak.enabled ? value.config.offPeak.start + '–' + value.config.offPeak.end : '关'),
          '任务：' + tasks,
          '租约：' + value.leases + '　收件箱待办：' + value.openInbox,
          '今日：' + value.today.tokens + ' tokens' + (value.today.cost ? ' ≈ ' + value.today.cost.toFixed(2) : ''),
          '下一个 tick：' + (value.nextActions.length ? value.nextActions.join(', ') : '空闲'),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '班组总览' }),
    timeoutMs: 20000,
    execute: async () => {
      const { ledger, config } = ctxOf()
      const records = await ledger.records()
      const state = fold(records)
      const planned = planTick(state, { now: Date.now(), config })
      const raw = await ledger.records()
      const tokens = tokensToday(raw, { now: Date.now(), tz: config.offPeak?.tz || 'Asia/Shanghai' })
      const team = describeTeam(ctxOf())
      return {
        ok: true,
        tasks: countBy([...state.tasks.values()], (task) => task.status),
        leases: state.leases.size,
        openInbox: [...state.inbox.values()].filter((item) => item.status === 'open').length,
        nextActions: [...new Set(planned.actions.map((action) => action.type))],
        deployment: deploymentSummary(ctxOf().deployment),
        team,
        config: {
          enabled: Boolean(config.enabled),
          homeWorkspace: config.homeWorkspace ?? null,
          offPeak: { enabled: config.offPeak?.enabled !== false, start: config.offPeak?.start, end: config.offPeak?.end },
          dailyBudget: config.dailyBudget ?? null,
          offPeakWindowActive: isOffPeak(Date.now(), config.offPeak),
        },
        today: {
          tokens,
          cost: Number.isFinite(config.costPerMToken) ? (tokens / 1e6) * config.costPerMToken : 0,
        },
      }
    },
  }
}

function describeTeam({ ctx, config }) {
  const empty = { available: false, home: config.homeWorkspace ?? null, lead: null, members: [] }
  if (!ctx) return empty
  try {
    const team = new TeamAdapter({ ctx, homeWorkspace: config.homeWorkspace })
    if (!team.available) return empty
    const members = team.members()
    return {
      available: true,
      home: config.homeWorkspace ?? null,
      lead: members.find((member) => member.role === 'lead')?.name ?? null,
      members,
    }
  } catch {
    return empty
  }
}

function crewTasksTool(ctxOf) {
  return {
    name: 'crew_tasks',
    description: '列出任务板：状态、owner、尝试/失败次数、写域。卡住的任务在这里一眼能看到。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '只看某个状态：todo/claimed/done/failed/blocked' },
        limit: { type: 'number', description: '最多返回多少条，默认 20' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(['查询失败：' + (value.error || '未知错误')])
        if (value.tasks.length === 0) return text(['没有符合条件的任务。'])
        return text([
          '共 ' + value.total + ' 条：',
          ...value.tasks.map((task) => '- ' + task.id + ' [' + task.status + '] ' + task.subject
            + (task.owner ? ' → ' + task.owner : '')
            + ' 尝试' + task.attempts + '/失败' + task.failures
            + (task.blockedReason ? ' 原因:' + task.blockedReason : '')),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '任务板' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const state = fold(await ledger.records())
      const all = [...state.tasks.values()]
        .filter((task) => !args.status || task.status === args.status)
        .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 20))
      return {
        ok: true,
        total: all.length,
        tasks: all.slice(0, limit).map((task) => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          owner: task.owner ?? null,
          attempts: task.attempts ?? 0,
          failures: task.failures ?? 0,
          blockedReason: task.reason ?? null,
        })),
      }
    },
  }
}

function crewTaskAddTool(ctxOf) {
  return {
    name: 'crew_task_add',
    description: '往任务板加一条任务。这是把活交给班组的方式：加完由调度器自己派给 worker 并盲审。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '一句话说明要做什么' },
        description: { type: 'string', description: '背景、约束、参考材料' },
        type: { type: 'string', enum: ['code', 'research', 'content', 'monitor'], description: '任务类型，决定权限档和验收 rubric，默认 code' },
        acceptance: { type: 'string', description: '验收标准；不填就用该类型的默认 rubric' },
        writeScopes: { type: 'array', items: { type: 'string' }, description: '允许写哪些路径前缀，如 ["src/"]' },
        priority: { type: 'number', description: '越大越先跑；>=100 视为急活，不受谷时延后' },
        deadline: { type: 'string', description: 'ISO 时间；临近 deadline 的任务不受谷时延后' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => text([value.ok
        ? '已加入：' + value.taskId + '（' + value.type + '，写域 ' + (value.writeScopes.join(', ') || '无') + '）'
        : '加任务失败：' + (value.error || '未知错误')]),
    },
    presentCall: () => ({ card: 'generic', title: '新任务' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const subject = String(args.subject ?? '').trim()
      if (!subject) return { ok: false, error: 'subject 必填' }
      const state = fold(await ledger.records())
      let next = 1
      for (const id of state.tasks.keys()) {
        const match = /-(\d+)$/u.exec(id)
        if (match) next = Math.max(next, Number(match[1]) + 1)
      }
      const taskId = 'task-' + next
      const kind = kindOf(args.type)
      const writeScopes = Array.isArray(args.writeScopes) && args.writeScopes.length > 0
        ? args.writeScopes.map(String)
        : kind.writeScopes
      await ledger.append({
        type: 'task.created',
        taskId,
        subject,
        description: args.description ? String(args.description).slice(0, 4000) : undefined,
        taskType: args.type ?? 'code',
        priority: Number.isFinite(args.priority) ? args.priority : 0,
        writeScopes,
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [],
        acceptance: args.acceptance ? String(args.acceptance).slice(0, 2000) : undefined,
        deadline: args.deadline,
      })
      return { ok: true, taskId, type: args.type ?? 'code', writeScopes }
    },
  }
}

function crewPlanTool(ctxOf) {
  return {
    name: 'crew_plan',
    description: '空跑一次巡检：返回当前时刻会触发的动作（收尸/派活/判死），但不会真的执行。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(['空跑失败：' + (value.error || '未知错误')])
        if (value.actions.length === 0) return text(['本轮无事可做（空闲，退避到 ' + value.nextTickMs + 'ms 后再看）'])
        return text([
          '本轮 ' + value.actions.length + ' 个动作：',
          ...value.actions.map((action) => '- ' + action.type + (action.taskId ? ' ' + action.taskId : '')),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '班组巡检预演' }),
    timeoutMs: 20000,
    execute: async () => {
      const { ledger, config } = ctxOf()
      const state = fold(await ledger.records())
      const planned = planTick(state, { now: Date.now(), config })
      return { ok: true, actions: planned.actions, nextTickMs: planned.nextTickMs }
    },
  }
}

function crewReportTool(ctxOf) {
  return {
    name: 'crew_report',
    description: 'worker/reviewer 的唯一回报通道：把本轮结果写进班组账本。执行结束必须调用，否则调度器判超时。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'handoff 里给你的 run id，原样带回' },
        status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'], description: '本轮结果' },
        summary: { type: 'string', description: '做了什么 / 为什么失败 / 评审哪条不满足' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '产物路径或链接' },
        needs: { type: 'string', description: '需要人或评审做什么，没有就留空' },
        tokens: { type: 'number', description: '本轮大约消耗的 token，可选' },
      },
      required: ['run_id', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => text([value.ok ? '已记账：' + value.runId + ' → ' + value.status : '记账失败：' + (value.error || '未知错误')]),
    },
    presentCall: () => ({ card: 'generic', title: '班组回报' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const runId = String(args.run_id ?? '').trim()
      if (!/^run-[0-9]+(-r)?$/u.test(runId)) return { ok: false, error: 'run_id 形状不对：' + runId }
      const status = String(args.status ?? '')
      if (!['succeeded', 'failed', 'blocked'].includes(status)) return { ok: false, error: 'status 只能是 succeeded/failed/blocked' }
      await ledger.append({
        type: 'run.reported',
        runId,
        status,
        summary: String(args.summary ?? '').slice(0, 4000),
        artifacts: Array.isArray(args.artifacts) ? args.artifacts.slice(0, 50).map(String) : [],
        needs: args.needs ? String(args.needs).slice(0, 1000) : undefined,
        tokens: Number.isFinite(args.tokens) ? args.tokens : undefined,
      })
      return { ok: true, runId, status }
    },
  }
}

function crewInboxTool(ctxOf) {
  return {
    name: 'crew_inbox',
    description: '人工收件箱：列出等你拍板的事，或对某一条给出结论（批准/驳回）。超时默认按配置处理。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'resolve'], description: '默认 list' },
        inbox_id: { type: 'string', description: 'resolve 时必填，如 inbox-1' },
        decision: { type: 'string', enum: ['approved', 'rejected'], description: 'resolve 时的结论' },
        note: { type: 'string', description: '给 agent 看的说明' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(['处理失败：' + (value.error || '未知错误')])
        if (value.resolved) return text(['已处理：' + value.resolved + ' → ' + value.decision])
        if (value.items.length === 0) return text(['收件箱是空的。'])
        return text([
          '待处理 ' + value.items.length + ' 条：',
          ...value.items.map((item) => '- ' + item.id + ' [' + item.taskId + '] ' + item.question
            + '（' + new Date(item.dueAt).toLocaleString('zh-CN', { hour12: false }) + ' 超时 ' + item.timeoutAction + '）'),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '班组收件箱' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const state = fold(await ledger.records())
      if ((args.action ?? 'list') === 'list') {
        return {
          ok: true,
          items: [...state.inbox.values()].filter((item) => item.status === 'open').map((item) => ({
            id: item.id, taskId: item.taskId, question: item.question, dueAt: item.dueAt, timeoutAction: item.timeoutAction,
          })),
        }
      }
      const id = String(args.inbox_id ?? '').trim()
      const item = state.inbox.get(id)
      if (!item || item.status !== 'open') return { ok: false, error: '没有这条待处理项：' + id }
      const decision = args.decision === 'approved' ? 'approved' : 'rejected'
      await ledger.append({ type: 'inbox.resolved', inboxId: id, decision, note: args.note ? String(args.note).slice(0, 1000) : undefined })
      if (decision === 'approved') await ledger.append({ type: 'task.released', taskId: item.taskId })
      else await ledger.append({ type: 'task.blocked', taskId: item.taskId, reason: 'rejected-by-human' })
      return { ok: true, resolved: id, decision }
    },
  }
}

export function apply(ctx, explicit = {}) {
  const config = resolveConfig(explicit, loadConfig())
  const dataDir = config.dataDir || dataDirFor()
  const deployment = loadDeployment()
  const ledger = new Ledger(config.ledgerFile || join(dataDir, 'ledger.jsonl'))
  const ctxOf = () => ({ ctx, config, ledger, deployment })

  const tools = [
    crewStatusTool(ctxOf),
    crewTasksTool(ctxOf),
    crewTaskAddTool(ctxOf),
    crewPlanTool(ctxOf),
    crewReportTool(ctxOf),
    crewInboxTool(ctxOf),
  ]
  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      console.warn('[crew] tool register failed:', tool.name, error)
    }
  }

  if (config.enabled && typeof ctx.inject === 'function') {
    // Services appear after this plugin loads, so wait for them instead of probing now.
    ctx.inject(['agents', 'agentTeams'], (scope) => {
      const team = new TeamAdapter({
        ctx: scope,
        homeWorkspace: config.homeWorkspace,
        log: (message) => console.log('[crew] ' + message),
      })
      const scheduler = new Scheduler({
        ledger,
        executor: new TeamExecutor({ ledger, team, pollMs: config.pollMs ?? 1500 }),
        config,
        log: (message) => console.log('[crew] ' + message),
      })
      scope.effect(() => {
        void scheduler.start()
        return () => scheduler.stop()
      })
      console.log('[crew] scheduler started; home=' + (config.homeWorkspace ?? '(newest session)'))
    })
  }

  console.log('[crew] host loaded; ledger=' + ledger.file
    + ' enabled=' + Boolean(config.enabled)
    + ' kinds=' + listKinds().length
    + (config.enabled ? '' : '（enabled=false：调度器不启动，工具仍可用）'))
}

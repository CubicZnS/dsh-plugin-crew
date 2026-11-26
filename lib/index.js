/**
 * dsh-plugin-crew — host half (P0 skeleton).
 *
 * P0 ships the pure core (ledger / fold / plan) and two read-only tools.
 * The scheduler loop is intentionally not started until M1.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from './ledger.js'
import { fold } from './fold.js'
import { planTick, DEFAULTS } from './plan.js'
import { Scheduler } from './scheduler.js'
import { TeamAdapter, teamAvailable } from './team.js'
import { TeamExecutor } from './team-executor.js'
import { listKinds } from './kinds.js'

export const name = 'dsh-plugin-crew'
export const inject = ['tools']

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }

function text(lines) {
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

function summarize(state) {
  const counts = {}
  for (const task of state.tasks.values()) counts[task.status] = (counts[task.status] ?? 0) + 1
  const openInbox = [...state.inbox.values()].filter((item) => item.status === 'open').length
  return { counts, leases: state.leases.size, openInbox }
}

function crewStatusTool(getLedger) {
  return {
    name: 'crew_status',
    description: '查看班组账本摘要：各状态任务数、有效租约、待处理的收件箱、下一个 tick 会做什么。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) return text(['查询失败：' + (value.error || '未知错误')])
        const parts = Object.entries(value.tasks || {}).map(([status, count]) => status + '=' + count)
        return text([
          '任务：' + (parts.length ? parts.join('  ') : '（空）'),
          '租约：' + value.leases + '　收件箱待办：' + value.openInbox,
          '下一个 tick：' + (value.nextActions.length ? value.nextActions.join(', ') : '空闲'),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '班组状态' }),
    timeoutMs: 20000,
    execute: async () => {
      const ledger = getLedger()
      if (!ledger) return { ok: false, error: '账本未配置' }
      const state = fold(await ledger.records())
      const planned = planTick(state, { now: Date.now() })
      const { counts, leases, openInbox } = summarize(state)
      return {
        ok: true,
        tasks: counts,
        leases,
        openInbox,
        nextActions: [...new Set(planned.actions.map((action) => action.type))],
      }
    },
  }
}

function crewTasksTool(getLedger) {
  return {
    name: 'crew_tasks',
    description: '列出班组任务板：状态、owner、尝试/失败次数、写域，以及卡住最久的任务。',
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
      const ledger = getLedger()
      if (!ledger) return { ok: false, error: '账本未配置' }
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

function crewPlanTool(getLedger) {
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
      const ledger = getLedger()
      if (!ledger) return { ok: false, error: '账本未配置' }
      const state = fold(await ledger.records())
      const planned = planTick(state, { now: Date.now() })
      return { ok: true, actions: planned.actions, nextTickMs: planned.nextTickMs }
    },
  }
}

function crewReportTool(getLedger) {
  return {
    name: 'crew_report',
    description: 'worker/reviewer 的唯一回报通道：把本轮结果写进班组账本。执行结束必须调用，否则调度器会判超时。',
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
      const ledger = getLedger()
      if (!ledger) return { ok: false, error: '账本未配置' }
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

function crewInboxTool(getLedger) {
  return {
    name: 'crew_inbox',
    description: '人工收件箱：列出等你拍板的事，或对某一条给出结论（批准/驳回）。超时默认按配置的 timeoutAction 处理。',
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
      const ledger = getLedger()
      if (!ledger) return { ok: false, error: '账本未配置' }
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

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || process.env.CREW_HOME || join(homedir(), '.dsh', 'crew')
  const ledger = new Ledger(config.ledgerFile || join(dataDir, 'ledger.jsonl'))
  const resolved = { ...DEFAULTS, ...config }
  const getLedger = () => ledger
  const tools = [
    crewStatusTool(getLedger),
    crewPlanTool(getLedger),
    crewTasksTool(getLedger),
    crewReportTool(getLedger),
    crewInboxTool(getLedger),
  ]

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      console.warn('[crew] tool register failed:', tool.name, error)
    }
  }
  // The unattended loop only starts when explicitly enabled and a Team is present.
  if (resolved.enabled && teamAvailable(ctx)) {
    const team = new TeamAdapter({ ctx, log: (message) => console.log('[crew] ' + message) })
    if (team.available) {
      const scheduler = new Scheduler({
        ledger,
        executor: new TeamExecutor({ ledger, team, pollMs: resolved.pollMs ?? 1500 }),
        config: resolved,
        log: (message) => console.log('[crew] ' + message),
      })
      ctx.effect(() => {
        void scheduler.start()
        return () => scheduler.stop()
      })
      console.log('[crew] scheduler started; worker=' + (resolved.workerName ?? 'worker'))
    } else {
      console.warn('[crew] enabled but no live Team lead found; scheduler not started')
    }
  }
  console.log('[crew] host loaded; ledger=' + ledger.file + ' tick=' + resolved.tickMs + 'ms kinds=' + listKinds().length)
}

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

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || process.env.CREW_HOME || join(homedir(), '.dsh', 'crew')
  const ledger = new Ledger(config.ledgerFile || join(dataDir, 'ledger.jsonl'))
  const resolved = { ...DEFAULTS, ...config }
  const getLedger = () => ledger
  const tools = [crewStatusTool(getLedger), crewPlanTool(getLedger)]

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      console.warn('[crew] tool register failed:', tool.name, error)
    }
  }
  console.log('[crew] host loaded (P0 skeleton); ledger=' + ledger.file + ' tick=' + resolved.tickMs + 'ms')
}

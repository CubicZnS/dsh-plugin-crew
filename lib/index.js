/**
 * dsh-plugin-crew — host half.
 *
 * Pull model: this plugin never creates agents or sessions. It owns the ledger,
 * hands the Lead session a self-contained job, and settles the report the worker
 * writes back. Dispatch is done by the Lead with the host's own subagent tools.
 */
import { join } from 'node:path'
import { Ledger } from './ledger.js'
import { fold } from './fold.js'
import { planTick, DEFAULTS } from './plan.js'
import { Scheduler } from './scheduler.js'
import { kindOf, listKinds, requiresReview } from './kinds.js'
import { workJobPrompt, reviewJobPrompt } from './handoff.js'
import { dataDirFor, loadConfig, loadDeployment, resolveConfig, deploymentSummary } from './config.js'
import { buildPanelData } from './panel.js'
import { tokensToday, isOffPeak } from './window.js'

export const name = 'dsh-plugin-crew'
export const inject = ['tools']

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }
const text = (lines) => [{ type: 'text', text: lines.filter(Boolean).join('\n') }]

function countBy(items, pick) {
  const counts = {}
  for (const item of items) counts[pick(item)] = (counts[pick(item)] ?? 0) + 1
  return counts
}

function nextId(state, kind) {
  let max = 0
  const pool = kind === 'run' ? state.runs.keys() : kind === 'lease' ? state.leases.keys() : state.inbox.keys()
  for (const key of pool) {
    const match = /-(\d+)(-r)?$/u.exec(key)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return kind + '-' + (max + 1)
}

function openInbox(ledger, state, { key, taskId, question, ttlMs, timeoutAction }) {
  const existing = [...state.inbox.values()].find((item) => item.status === 'open' && item.key === key)
  if (existing) return existing.id
  const now = Date.now()
  const id = nextId(state, 'inbox')
  void ledger.append({
    type: 'inbox.opened', inboxId: id, key, taskId, question,
    dueAt: now + (ttlMs ?? 4 * 3600 * 1000), timeoutAction: timeoutAction ?? 'reject',
  })
  return id
}

function crewStatusTool(ctxOf) {
  return {
    name: 'crew_status',
    description: '班组总览：部署、任务/租约/收件箱、今日花费、下一轮该做什么。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => {
        if (!v.ok) return text(['查询失败：' + (v.error || '未知错误')])
        const tasks = Object.entries(v.tasks).map(([k, n]) => k + '=' + n).join('  ') || '（空）'
        return text([
          '部署：' + (v.deployment.deployed ? 'v' + v.deployment.version : '未部署'),
          '任务：' + tasks,
          '待处理：' + v.pending.work + ' 个可执行，' + v.pending.review + ' 个待评审　收件箱 ' + v.openInbox,
          '今日：' + v.today.tokens + ' tokens' + (v.today.cost ? ' ≈ ' + v.today.cost.toFixed(2) : ''),
          v.pending.work + v.pending.review > 0 ? '下一句说：crew_pull 领活' : '现在没活，歇着。',
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '班组总览' }),
    timeoutMs: 20000,
    execute: async () => {
      const { ledger, config, deployment } = ctxOf()
      const state = fold(await ledger.records())
      const planned = planTick(state, { now: Date.now(), config })
      const tokens = tokensToday(await ledger.records(), { now: Date.now(), tz: config.offPeak?.tz || 'Asia/Shanghai' })
      const tasks = [...state.tasks.values()]
      return {
        ok: true,
        tasks: countBy(tasks, (t) => t.status),
        leases: state.leases.size,
        openInbox: [...state.inbox.values()].filter((i) => i.status === 'open').length,
        pending: {
          work: tasks.filter((t) => t.status === 'todo').length,
          review: tasks.filter((t) => t.status === 'review').length,
        },
        nextActions: [...new Set(planned.actions.map((a) => a.type))],
        deployment: deploymentSummary(deployment),
        config: {
          enabled: Boolean(config.enabled),
          offPeak: { enabled: config.offPeak?.enabled !== false, start: config.offPeak?.start, end: config.offPeak?.end },
          offPeakWindowActive: isOffPeak(Date.now(), config.offPeak),
          dailyBudget: config.dailyBudget ?? null,
        },
        today: { tokens, cost: Number.isFinite(config.costPerMToken) ? (tokens / 1e6) * config.costPerMToken : 0 },
      }
    },
  }
}

function crewTaskAddTool(ctxOf) {
  return {
    name: 'crew_task_add',
    description: '往任务板加一条任务。加完用 crew_pull 领活交给 subagent。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '一句话说明要做什么' },
        description: { type: 'string', description: '背景、约束、参考材料' },
        type: { type: 'string', enum: ['code', 'research', 'content', 'monitor'], description: '任务类型，决定 rubric 与是否需要盲审，默认 code' },
        acceptance: { type: 'string', description: '验收标准；不填用该类型默认 rubric' },
        writeScopes: { type: 'array', items: { type: 'string' }, description: '允许写哪些路径前缀' },
        priority: { type: 'number', description: '越大越先跑' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id' },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => text([v.ok ? '已加入 ' + v.taskId + '（' + v.type + (v.needsReview ? '，需盲审' : '') + '）' : '失败：' + (v.error || '未知错误')]),
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
      const type = args.type ?? 'code'
      const kind = kindOf(type)
      const writeScopes = Array.isArray(args.writeScopes) && args.writeScopes.length > 0 ? args.writeScopes.map(String) : kind.writeScopes
      await ledger.append({
        type: 'task.created', taskId, subject,
        description: args.description ? String(args.description).slice(0, 4000) : undefined,
        taskType: type,
        priority: Number.isFinite(args.priority) ? args.priority : 0,
        writeScopes,
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [],
        acceptance: args.acceptance ? String(args.acceptance).slice(0, 2000) : undefined,
      })
      return { ok: true, taskId, type, needsReview: requiresReview(type), writeScopes }
    },
  }
}

function crewTaskCancelTool(ctxOf) {
  return {
    name: 'crew_task_cancel',
    description: '取消一个任务（写墓碑，不删记录）。已完成的不能取消；已认领的会连带释放。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要取消的任务 id' },
        reason: { type: 'string', description: '为什么取消' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => text([v.ok ? '已取消 ' + v.taskId : '取消失败：' + (v.error || '未知错误')]),
    },
    presentCall: () => ({ card: 'generic', title: '取消任务' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const taskId = String(args.task_id ?? '').trim()
      const state = fold(await ledger.records())
      const task = state.tasks.get(taskId)
      if (!task) return { ok: false, error: '没有这个任务：' + taskId }
      if (task.status === 'done') return { ok: false, error: '已完成的任务不能取消' }
      if (task.status === 'canceled') return { ok: true, taskId }
      await ledger.append({ type: 'task.canceled', taskId, reason: args.reason ? String(args.reason).slice(0, 500) : undefined })
      return { ok: true, taskId }
    },
  }
}

function crewPullTool(ctxOf) {
  return {
    name: 'crew_pull',
    description: '领活。返回 N 个完整作业（含给 subagent 的提示词）。对每个作业：用 subagent 工具派出去，提示词原样传给它；它干完会自己调 crew_report。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多领几个，默认 2' },
        type: { type: 'string', description: '只看某一类任务' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => {
        if (!v.ok) return text(['领活失败：' + (v.error || '未知错误')])
        if (v.jobs.length === 0) return text(['没有可领的活。'])
        return text([
          '领到 ' + v.jobs.length + ' 个作业：',
          ...v.jobs.map((job) => '- [' + job.kind + '] ' + job.taskId + '　' + job.subject + '　run=' + job.runId),
          '',
          '用法：对每个作业调用 subagent，prompt 用返回里的 prompt 原文。',
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '领活' }),
    timeoutMs: 30000,
    execute: async (args) => {
      const { ledger, config } = ctxOf()
      const state = fold(await ledger.records())
      const now = Date.now()
      const limit = Math.max(1, Math.min(5, Number(args.limit) || 2))
      const jobs = []

      const matchesType = (task) => !args.type || task.type === args.type
      const claimed = [...state.tasks.values()].filter((t) => t.status === 'claimed')
      const busyScopes = new Set(claimed.flatMap((t) => t.writeScopes ?? []))

      // reviews first: they unblock finishing
      for (const task of [...state.tasks.values()].filter((t) => t.status === 'review' && matchesType(t))) {
        if (jobs.length >= limit) break
        const runId = nextId(state, 'run') + '-r'
        const prompt = reviewJobPrompt({ task, runId })
        await ledger.append({ type: 'run.started', runId, taskId: task.id, sessionId: 'subagent', kind: 'review', prompt })
        jobs.push({ kind: 'review', taskId: task.id, runId, subject: task.subject, prompt })
      }

      for (const task of [...state.tasks.values()].filter((t) => t.status === 'todo' && matchesType(t))) {
        if (jobs.length >= limit) break
        if ((task.dependsOn ?? []).some((id) => state.tasks.get(id)?.status !== 'done')) continue
        if ((task.failures ?? 0) >= config.maxAttempts) continue
        const scopes = task.writeScopes ?? []
        if (scopes.some((scope) => busyScopes.has(scope))) continue
        const runId = nextId(state, 'run')
        const leaseId = nextId(state, 'lease')
        const prompt = workJobPrompt({ task, runId })
        await ledger.append({ type: 'task.claimed', taskId: task.id, owner: 'lead', leaseId, expiresAt: now + config.leaseTtlMs })
        await ledger.append({ type: 'run.started', runId, taskId: task.id, sessionId: 'subagent', kind: 'work', prompt })
        for (const scope of scopes) busyScopes.add(scope)
        jobs.push({ kind: 'work', taskId: task.id, runId, subject: task.subject, prompt })
      }
      return { ok: true, jobs }
    },
  }
}

function crewReportTool(ctxOf) {
  return {
    name: 'crew_report',
    description: 'worker/reviewer 唯一的回报通道：写进账本并推进任务状态。干完必须调用。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: '作业里给你的 run id，原样带回' },
        status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        needs: { type: 'string' },
        tokens: { type: 'number' },
      },
      required: ['run_id', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => text([v.ok ? '已记账 ' + v.runId + ' → ' + v.status + (v.next ? '　任务转 ' + v.next : '') : '失败：' + (v.error || '未知错误')]),
    },
    presentCall: () => ({ card: 'generic', title: '回报' }),
    timeoutMs: 30000,
    execute: async (args) => {
      const { ledger, config } = ctxOf()
      const runId = String(args.run_id ?? '').trim()
      if (!/^run-[0-9]+(-r)?$/u.test(runId)) return { ok: false, error: 'run_id 形状不对：' + runId }
      const status = String(args.status ?? '')
      if (!['succeeded', 'failed', 'blocked'].includes(status)) return { ok: false, error: 'status 只能是 succeeded/failed/blocked' }

      const state = fold(await ledger.records())
      const run = state.runs.get(runId)
      if (!run) return { ok: false, error: '没有这个 run：' + runId }
      const task = state.tasks.get(run.taskId)

      await ledger.append({
        type: 'run.reported', runId, status,
        summary: String(args.summary ?? '').slice(0, 4000),
        artifacts: Array.isArray(args.artifacts) ? args.artifacts.slice(0, 50).map(String) : [],
        needs: args.needs ? String(args.needs).slice(0, 1000) : undefined,
        tokens: Number.isFinite(args.tokens) ? args.tokens : undefined,
      })

      let next = undefined
      if (run.kind === 'review') {
        const verdict = status === 'succeeded' ? 'pass' : 'fail'
        await ledger.append({ type: 'review.verdict', runId, taskId: run.taskId, verdict, notes: String(args.summary ?? '').slice(0, 1000) })
        next = verdict === 'pass' ? 'done' : ((task?.failures ?? 0) + 1 >= config.maxAttempts ? 'blocked' : 'todo')
      } else if (status === 'succeeded') {
        if (task && requiresReview(task.type)) {
          await ledger.append({ type: 'task.review.requested', taskId: run.taskId })
          next = 'review'
        } else {
          await ledger.append({ type: 'task.completed', taskId: run.taskId })
          next = 'done'
        }
      } else if (status === 'blocked') {
        await ledger.append({ type: 'task.blocked', taskId: run.taskId, reason: 'worker-blocked' })
        openInbox(ledger, state, {
          key: 'worker-blocked:' + run.taskId, taskId: run.taskId,
          question: '任务 ' + run.taskId + ' 说它卡住了：' + String(args.summary ?? '').slice(0, 200),
          ttlMs: config.inboxTtlMs, timeoutAction: config.inboxTimeout,
        })
        next = 'blocked'
      } else {
        const failures = (task?.failures ?? 0) + 1
        if (failures >= config.maxAttempts) {
          await ledger.append({ type: 'task.blocked', taskId: run.taskId, reason: 'retry-exhausted' })
          openInbox(ledger, state, {
            key: 'retry-exhausted:' + run.taskId, taskId: run.taskId,
            question: '任务 ' + run.taskId + ' 连续失败 ' + failures + ' 次，要人决定。',
            ttlMs: config.inboxTtlMs, timeoutAction: config.inboxTimeout,
          })
          next = 'blocked'
        } else {
          await ledger.append({ type: 'task.released', taskId: run.taskId })
          next = 'todo'
        }
      }
      return { ok: true, runId, status, next }
    },
  }
}

function crewTasksTool(ctxOf) {
  return {
    name: 'crew_tasks',
    description: '任务板：状态、owner、尝试/失败次数。卡住的在这里一眼能看到。',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'number' } },
      required: [], additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => {
        if (!v.ok) return text(['查询失败：' + (v.error || '未知错误')])
        if (v.tasks.length === 0) return text(['没有符合条件的任务。'])
        return text([
          '共 ' + v.total + ' 条：',
          ...v.tasks.map((t) => '- ' + t.id + ' [' + t.status + '] ' + t.subject + (t.owner ? ' → ' + t.owner : '') + ' 尝试' + t.attempts + '/失败' + t.failures + (t.blockedReason ? ' 原因:' + t.blockedReason : '')),
        ])
      },
    },
    presentCall: () => ({ card: 'generic', title: '任务板' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const state = fold(await ledger.records())
      const all = [...state.tasks.values()]
        .filter((t) => !args.status || t.status === args.status)
        .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 20))
      return {
        ok: true, total: all.length,
        tasks: all.slice(0, limit).map((t) => ({
          id: t.id, subject: t.subject, status: t.status, owner: t.owner ?? null,
          attempts: t.attempts ?? 0, failures: t.failures ?? 0, blockedReason: t.reason ?? null,
        })),
      }
    },
  }
}

function crewInboxTool(ctxOf) {
  return {
    name: 'crew_inbox',
    description: '人工收件箱：列出等你拍板的事，或给某一条结论。超时按配置处理（默认驳回）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'resolve'] },
        inbox_id: { type: 'string' },
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        note: { type: 'string' },
      },
      required: [], additionalProperties: false,
    },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => {
        if (!v.ok) return text(['处理失败：' + (v.error || '未知错误')])
        if (v.resolved) return text(['已处理 ' + v.resolved + ' → ' + v.decision])
        if (v.items.length === 0) return text(['收件箱是空的。'])
        return text(['待处理 ' + v.items.length + ' 条：', ...v.items.map((i) => '- ' + i.id + ' [' + i.taskId + '] ' + i.question)])
      },
    },
    presentCall: () => ({ card: 'generic', title: '收件箱' }),
    timeoutMs: 20000,
    execute: async (args) => {
      const { ledger } = ctxOf()
      const state = fold(await ledger.records())
      if ((args.action ?? 'list') === 'list') {
        return { ok: true, items: [...state.inbox.values()].filter((i) => i.status === 'open').map((i) => ({ id: i.id, taskId: i.taskId, question: i.question, dueAt: i.dueAt, timeoutAction: i.timeoutAction })) }
      }
      const id = String(args.inbox_id ?? '').trim()
      const item = state.inbox.get(id)
      if (!item || item.status !== 'open') return { ok: false, error: '没有这条待处理项：' + id }
      const decision = args.decision === 'approved' ? 'approved' : 'rejected'
      await ledger.append({ type: 'inbox.resolved', inboxId: id, decision, note: args.note ? String(args.note).slice(0, 1000) : undefined })
      await ledger.append(decision === 'approved'
        ? { type: 'task.released', taskId: item.taskId }
        : { type: 'task.blocked', taskId: item.taskId, reason: 'rejected-by-human' })
      return { ok: true, resolved: id, decision }
    },
  }
}

function crewPlanTool(ctxOf) {
  return {
    name: 'crew_plan',
    description: '空跑一次巡检：收尸/审计/判死会做什么，不实际执行。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: OBJECT_SCHEMA,
      render: (_a, v) => text(v.actions.length === 0
        ? ['本轮无事可做。']
        : ['本轮 ' + v.actions.length + ' 个动作：', ...v.actions.map((a) => '- ' + a.type + (a.taskId ? ' ' + a.taskId : ''))]),
    },
    presentCall: () => ({ card: 'generic', title: '巡检预演' }),
    timeoutMs: 20000,
    execute: async () => {
      const { ledger, config } = ctxOf()
      const state = fold(await ledger.records())
      const planned = planTick(state, { now: Date.now(), config })
      return { ok: true, actions: planned.actions, nextTickMs: planned.nextTickMs }
    },
  }
}

/** One JSON snapshot for the client panel, served over the host's rpc bridge. */
function registerPanelRpc(ctx, ledger) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (scope) => {
    try {
      const connection = scope.get ? scope.get('connection') : scope.connection
      if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return undefined
      return connection.fetch.register({
        path: '/api/crewPanel',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return new Response('body is not JSON', { status: 400 })
          }
          if (!body || body.method !== 'crewPanel') return new Response('RPC method mismatch', { status: 400 })
          try {
            const value = buildPanelData(await ledger.records())
            return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
          } catch (error) {
            return Response.json({
              type: 'server-response',
              rpcId: body.rpcId,
              result: { ok: false, error: { code: 'panel-failed', message: String((error && error.message) || error) } },
            })
          }
        },
      })
    } catch (error) {
      console.warn('[crew] panel rpc skipped:', error)
      return undefined
    }
  })
}

export function apply(ctx, explicit = {}) {
  const config = resolveConfig(explicit, loadConfig())
  const dataDir = config.dataDir || dataDirFor()
  const deployment = loadDeployment()
  const ledger = new Ledger(config.ledgerFile || join(dataDir, 'ledger.jsonl'))
  const ctxOf = () => ({ ctx, config, ledger, deployment })

  const tools = [
    crewStatusTool(ctxOf), crewTaskAddTool(ctxOf), crewTaskCancelTool(ctxOf), crewPullTool(ctxOf), crewReportTool(ctxOf),
    crewTasksTool(ctxOf), crewInboxTool(ctxOf), crewPlanTool(ctxOf),
  ]
  for (const tool of tools) {
    try { ctx.tools.register(tool) } catch (error) { console.warn('[crew] tool register failed:', tool.name, error) }
  }

  registerPanelRpc(ctx, ledger)

  // Watchdog only: pull mode never dispatches, it just reaps and escalates.
  if (config.enabled && typeof ctx.effect === 'function') {
    try {
      const scheduler = new Scheduler({ ledger, config: { ...config, dispatchMode: 'pull' }, log: (m) => console.log('[crew] ' + m) })
      ctx.effect(() => { void scheduler.start(); return () => scheduler.stop() })
      console.log('[crew] watchdog started (pull mode)')
    } catch (error) {
      console.warn('[crew] watchdog not started: ' + error)
    }
  }

  console.log('[crew] host loaded; ledger=' + ledger.file + ' enabled=' + Boolean(config.enabled) + ' kinds=' + listKinds().length)
}

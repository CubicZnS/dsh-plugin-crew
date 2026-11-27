/**
 * Watchdog loop. It never dispatches work — it only keeps the ledger honest:
 * reap expired claims, flag stalls, escalate a wedged board, expire approvals.
 */
import { fold } from './fold.js'
import { planTick, DEFAULTS } from './plan.js'

const iso = (ms) => new Date(ms).toISOString()

function maxSuffix(keys) {
  let max = 0
  for (const key of keys) {
    const match = /-(\d+)(-r)?$/u.exec(key)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

export class Scheduler {
  #counter = { inbox: 0 }
  #ticking = false
  #stalled = 0
  #timer = undefined
  #stopped = false

  constructor({ ledger, config = {}, clock = () => Date.now(), log = () => {} }) {
    this.ledger = ledger
    this.config = { ...DEFAULTS, ...config }
    this.clock = clock
    this.log = log
  }

  /** Run exactly one pass. Concurrent calls collapse into a single pass. */
  async tick() {
    if (this.#ticking || this.#stopped) return { skipped: true, actions: [] }
    this.#ticking = true
    try {
      await this.#expireInbox()
      const state = fold(await this.ledger.records())
      this.#counter.inbox = Math.max(this.#counter.inbox, maxSuffix(state.inbox.keys()))
      const planned = planTick(state, { now: this.clock(), config: this.config, stalledTicks: this.#stalled })

      let acted = false
      for (const action of planned.actions) {
        if (action.type === 'reap') {
          await this.#reap(state, action)
          acted = true
        } else if (action.type === 'deadlock') {
          await this.#openInbox(state, {
            key: 'deadlock',
            taskId: action.taskIds[0],
            question: '班组卡死：' + action.taskIds.length + ' 个任务都在等，没有可领的活。要人拍板。'
              + (action.taskIds.length ? '（' + action.taskIds.join(', ') + '）' : ''),
          })
          acted = true
        } else if (action.type === 'audit') {
          this.log('audit: task ' + action.taskId + ' claimed for ' + action.ageMs + 'ms')
        }
      }

      const open = [...state.tasks.values()].filter((task) => task.status !== 'done' && task.status !== 'failed').length
      this.#stalled = open > 0 && !acted ? this.#stalled + 1 : 0
      return { actions: planned.actions, nextTickMs: planned.nextTickMs }
    } catch (error) {
      // A watchdog fault must never take the host down.
      this.log('tick failed: ' + (error && error.message ? error.message : error))
      return { skipped: true, actions: [], nextTickMs: this.config.idleTickMs, error: String(error) }
    } finally {
      this.#ticking = false
    }
  }

  async start() {
    while (!this.#stopped) {
      let nextTickMs = this.config.idleTickMs
      try {
        nextTickMs = (await this.tick()).nextTickMs ?? nextTickMs
      } catch (error) {
        this.log('tick loop swallowed: ' + error)
      }
      if (this.#stopped) break
      await new Promise((resolve) => {
        // Not unref'd: an idle crew must stay resident, it just costs nothing.
        this.#timer = setTimeout(resolve, nextTickMs)
      })
    }
  }

  stop() {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
  }

  /** An approval nobody answered falls back to the configured action. */
  async #expireInbox() {
    const now = this.clock()
    const state = fold(await this.ledger.records())
    for (const item of state.inbox.values()) {
      if (item.status !== 'open' || !item.dueAt || item.dueAt > now) continue
      const decision = item.timeoutAction === 'approve' ? 'approved' : 'rejected'
      await this.ledger.append({ type: 'inbox.resolved', inboxId: item.id, decision, note: 'timeout' })
      if (decision === 'approved') await this.ledger.append({ type: 'task.released', taskId: item.taskId })
      else await this.ledger.append({ type: 'task.blocked', taskId: item.taskId, reason: 'approval-timeout' })
      this.log('inbox ' + item.id + ' expired → ' + decision)
    }
  }

  async #reap(state, action) {
    const task = state.tasks.get(action.taskId)
    if (!task) return
    const after = {
      ...state,
      tasks: new Map(state.tasks),
      inbox: new Map(state.inbox),
    }
    if ((task.failures ?? 0) >= this.config.maxAttempts) {
      await this.ledger.append({ type: 'task.blocked', taskId: task.id, reason: 'lease-expired-retry-exhausted' })
      await this.#openInbox(after, {
        key: 'retry-exhausted:' + task.id,
        taskId: task.id,
        question: '任务 ' + task.id + ' 的认领过期且已用尽重试，要人决定。',
      })
      return
    }
    await this.ledger.append({ type: 'task.released', taskId: task.id })
    this.log('reaped ' + task.id + ' from ' + action.owner + ' (lease-expired)')
  }

  async #openInbox(state, { key, taskId, question }) {
    const existing = [...state.inbox.values()].find((item) => item.status === 'open' && item.key === key)
    if (existing) return
    this.#counter.inbox += 1
    await this.ledger.append({
      type: 'inbox.opened',
      inboxId: 'inbox-' + this.#counter.inbox,
      taskId, question, key,
      dueAt: this.clock() + this.config.inboxTtlMs,
      timeoutAction: this.config.inboxTimeout,
      at: iso(this.clock()),
    })
    this.log('inbox: ' + question)
  }
}

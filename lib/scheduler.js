/**
 * The tick loop. Deterministic code — no model calls.
 *
 * Invariants:
 *  - one tick at a time (single-flight guard);
 *  - a task is claimed at most once per attempt, from freshly folded state;
 *  - every claim carries a lease with an expiry, renewed while the run is live;
 *  - a restart reconciles in-flight runs to "interrupted" before dispatching anything;
 *  - ids never collide inside a tick (counters are seeded from state, then local).
 */
import { fold } from './fold.js'
import { planTick, DEFAULTS } from './plan.js'
import { budgetExhausted, shouldDefer } from './window.js'

const iso = (ms) => new Date(ms).toISOString()

function maxSuffix(keys) {
  let max = 0
  for (const key of keys) {
    const match = /-(\d+)$/.exec(key)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

export class Scheduler {
  #running = new Map()
  #pending = new Set()
  #counter = { run: 0, lease: 0, inbox: 0 }
  #ticking = false
  #stalled = 0
  #timer = undefined
  #stopped = false

  constructor({ ledger, executor, config = {}, clock = () => Date.now(), log = () => {} }) {
    this.ledger = ledger
    this.executor = executor
    this.config = { ...DEFAULTS, ...config }
    this.clock = clock
    this.log = log
  }

  get runningCount() {
    return this.#running.size
  }

  /** Await every in-flight settle. Tests need it; graceful shutdown will too. */
  async whenIdle() {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending])
  }

  /** Startup reconciliation: nothing from a previous process can still be running. */
  async recover() {
    const state = fold(await this.ledger.records())
    this.#seed(state)
    const interrupted = []
    for (const run of state.runs.values()) {
      if (run.status !== 'running') continue
      await this.ledger.append({ type: 'run.finished', runId: run.id, status: 'interrupted', error: 'process-restart' })
      const task = state.tasks.get(run.taskId)
      if (task && task.status === 'claimed') {
        await this.ledger.append({ type: 'task.released', taskId: task.id })
      }
      interrupted.push(run.id)
    }
    if (interrupted.length > 0) this.log('recovered ' + interrupted.length + ' interrupted run(s)', { runs: interrupted })
    return interrupted
  }

  /** Run exactly one tick. Concurrent calls collapse into a single pass. */
  async tick() {
    if (this.#ticking || this.#stopped) return { skipped: true, actions: [] }
    if (typeof this.executor.isReady === 'function' && !this.executor.isReady()) {
      return { skipped: true, actions: [], nextTickMs: this.config.idleTickMs }
    }
    this.#ticking = true
    try {
      await this.#expireInbox()
      const records = await this.ledger.records()
      const state = fold(records)
      this.#seed(state)
      const now = this.clock()
      const planned = planTick(state, {
        now,
        config: this.config,
        runningCount: this.#running.size,
        stalledTicks: this.#stalled,
      })
      const budget = budgetExhausted(records, { now, config: this.config })
      let acted = false
      let deferred = false
      for (const action of planned.actions) {
        if (action.type === 'dispatch') {
          const task = state.tasks.get(action.taskId)
          if (budget) {
            await this.#openInbox(state, {
              key: 'budget',
              taskId: action.taskId,
              question: '今日预算已用完（' + this.config.dailyBudget + '），要人决定是否继续。',
            })
            deferred = true
            continue
          }
          if (task && shouldDefer(task, now, this.config)) {
            this.log('deferred ' + task.id + ' to off-peak')
            deferred = true
            continue
          }
        }
        if (action.type === 'reap') {
          await this.#reap(state, action)
          acted = true
        } else if (action.type === 'dispatch') {
          await this.#dispatch(state, action)
          acted = true
        } else if (action.type === 'deadlock') {
          await this.#openInbox(state, {
            key: 'deadlock',
            taskId: action.taskIds[0],
            question: '班组卡死：' + action.taskIds.length + ' 个任务都在等，没有可派活的。要人拍板怎么继续。'
              + (action.taskIds.length ? '（' + action.taskIds.join(', ') + '）' : ''),
          })
          acted = true
        } else if (action.type === 'audit') {
          this.log('audit: task ' + action.taskId + ' claimed for ' + action.ageMs + 'ms', action)
        }
      }

      const open = [...state.tasks.values()].filter((task) => task.status !== 'done' && task.status !== 'failed').length
      this.#stalled = open > 0 && !acted && !deferred ? this.#stalled + 1 : 0
      return { actions: planned.actions, nextTickMs: planned.nextTickMs }
    } catch (error) {
      // A scheduler fault must never take the host down.
      this.log('tick failed: ' + (error && error.message ? error.message : error))
      return { skipped: true, actions: [], nextTickMs: this.config.idleTickMs, error: String(error) }
    } finally {
      this.#ticking = false
    }
  }

  /** Keep ticking until stop(); each round schedules the next by the planned backoff. */
  async start() {
    await this.recover()
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
    for (const entry of this.#running.values()) {
      if (entry.renew) clearInterval(entry.renew)
      entry.abort?.abort()
    }
    this.#running.clear()
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

  #seed(state) {
    this.#counter.run = Math.max(this.#counter.run, maxSuffix(state.runs.keys()))
    this.#counter.lease = Math.max(this.#counter.lease, maxSuffix(state.leases.keys()))
    this.#counter.inbox = Math.max(this.#counter.inbox, maxSuffix(state.inbox.keys()))
  }

  #next(kind) {
    this.#counter[kind] += 1
    return kind + '-' + this.#counter[kind]
  }

  async #reap(state, action) {
    const task = state.tasks.get(action.taskId)
    if (!task) return
    const live = [...state.runs.values()].find((run) => run.taskId === action.taskId && run.status === 'running')
    if (live) {
      await this.ledger.append({ type: 'run.finished', runId: live.id, status: 'timed_out', error: 'lease-expired' })
    }
    // Retrying is bounded: after maxAttempts real failures the task needs a human.
    const after = fold(await this.ledger.records())
    this.#seed(after)
    const latest = after.tasks.get(task.id) ?? task
    if ((latest.failures ?? 0) >= this.config.maxAttempts) {
      await this.ledger.append({ type: 'task.blocked', taskId: task.id, reason: 'retry-exhausted' })
      await this.#openInbox(after, {
        key: 'retry-exhausted:' + task.id,
        taskId: task.id,
        question: '任务 ' + task.id + ' 连续 ' + latest.failures + ' 次失败，要人决定是放弃、改需求还是加资源。',
      })
      return
    }
    await this.ledger.append({ type: 'task.released', taskId: task.id })
    this.log('reaped ' + task.id + ' from ' + action.owner + ' (lease-expired)')
  }

  async #dispatch(state, action) {
    const task = state.tasks.get(action.taskId)
    if (!task || task.status !== 'todo') return
    if ([...this.#running.values()].some((entry) => entry.taskId === task.id)) return

    const now = this.clock()
    const leaseId = this.#next('lease')
    const runId = this.#next('run')
    const expiresAt = now + this.config.leaseTtlMs

    await this.ledger.append({
      type: 'task.claimed', taskId: task.id, owner: 'worker', leaseId, expiresAt, at: iso(now),
    })
    await this.ledger.append({
      type: 'run.started', runId, taskId: task.id, sessionId: 'stub-' + runId, startedAt: iso(now), at: iso(now),
    })

    const controller = new AbortController()
    const renew = setInterval(() => {
      void this.ledger.append({ type: 'lease.renewed', leaseId, expiresAt: this.clock() + this.config.leaseTtlMs })
    }, this.config.leaseRenewMs)
    if (renew.unref) renew.unref()

    this.#running.set(runId, { taskId: task.id, abort: controller, renew })

    const settled = this.executor.run(task, { signal: controller.signal, runId })
      .then((result) => this.#settle(runId, task, result))
      .catch((error) => this.#settle(runId, task, { status: 'failed', error: String((error && error.message) || error) }))
    this.#pending.add(settled)
    void settled.finally(() => this.#pending.delete(settled))
  }

  async #settle(runId, task, result) {
    const entry = this.#running.get(runId)
    if (entry?.renew) clearInterval(entry.renew)
    this.#running.delete(runId)

    const status = result?.status === 'succeeded' ? 'succeeded' : result?.status === 'cancelled' ? 'cancelled' : 'failed'
    await this.ledger.append({
      type: 'run.finished', runId, status, tokens: result?.tokens, error: result?.error,
      finishedAt: iso(this.clock()),
    })
    if (status === 'succeeded') {
      await this.ledger.append({ type: 'task.completed', taskId: task.id })
      return
    }

    const state = fold(await this.ledger.records())
    this.#seed(state)
    const latest = state.tasks.get(task.id) ?? task
    if ((latest.failures ?? 0) >= this.config.maxAttempts) {
      await this.ledger.append({ type: 'task.blocked', taskId: task.id, reason: 'retry-exhausted' })
      await this.#openInbox(state, {
        key: 'retry-exhausted:' + task.id,
        taskId: task.id,
        question: '任务 ' + task.id + ' 连续 ' + latest.failures + ' 次失败，要人决定下一步。',
      })
    } else {
      await this.ledger.append({ type: 'task.released', taskId: task.id })
    }
  }

  async #openInbox(state, { key, taskId, question }) {
    const existing = [...state.inbox.values()].find((item) => item.status === 'open' && item.key === key)
    if (existing) return
    const now = this.clock()
    await this.ledger.append({
      type: 'inbox.opened',
      inboxId: this.#next('inbox'),
      taskId, question, key,
      dueAt: now + this.config.inboxTtlMs,
      timeoutAction: this.config.inboxTimeout,
      at: iso(now),
    })
    this.log('inbox: ' + question)
  }
}

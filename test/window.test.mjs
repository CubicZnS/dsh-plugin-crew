import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { Scheduler } from '../lib/scheduler.js'
import { fold } from '../lib/fold.js'
import { isOffPeak, shouldDefer, budgetExhausted, parseClock, tokensToday } from '../lib/window.js'

const OFF_PEAK = { enabled: true, start: '00:30', end: '08:30', tz: 'Asia/Shanghai' }
const at = (iso) => Date.parse(iso)

test('off-peak window is interpreted in the configured zone', () => {
  assert.equal(isOffPeak(at('2026-11-26T03:00:00+08:00'), OFF_PEAK), true)
  assert.equal(isOffPeak(at('2026-11-26T00:29:00+08:00'), OFF_PEAK), false)
  assert.equal(isOffPeak(at('2026-11-26T20:00:00+08:00'), OFF_PEAK), false)
  assert.equal(isOffPeak(at('2026-11-25T19:00:00Z'), OFF_PEAK), true, '19:00Z is 03:00 in Shanghai')
  assert.equal(isOffPeak(at('2026-11-26T20:00:00+08:00'), { ...OFF_PEAK, enabled: false }), true)
})

test('windows may wrap midnight', () => {
  const night = { enabled: true, start: '22:00', end: '06:00', tz: 'Asia/Shanghai' }
  assert.equal(isOffPeak(at('2026-11-26T23:30:00+08:00'), night), true)
  assert.equal(isOffPeak(at('2026-11-26T05:59:00+08:00'), night), true)
  assert.equal(isOffPeak(at('2026-11-26T12:00:00+08:00'), night), false)
  assert.equal(parseClock('24:00'), undefined)
})

test('urgent and deadline-bound work ignores the cheap window', () => {
  const now = at('2026-11-26T20:00:00+08:00')
  const config = { offPeak: OFF_PEAK, urgentPriority: 100, deadlineGraceMs: 6 * 3600 * 1000 }
  assert.equal(shouldDefer({ id: 'task-1' }, now, config), true, 'normal work waits')
  assert.equal(shouldDefer({ id: 'task-2', priority: 100 }, now, config), false, 'urgent goes now')
  assert.equal(shouldDefer({ id: 'task-3', deadline: '2026-11-26T23:00:00+08:00' }, now, config), false, 'deadline inside grace')
  assert.equal(shouldDefer({ id: 'task-4', deadline: '2026-11-30T00:00:00+08:00' }, now, config), true, 'distant deadline waits')
})

test('the scheduler defers instead of burning a slot during peak hours', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-window-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })

  const scheduler = new Scheduler({
    ledger,
    executor: { run: async () => ({ status: 'succeeded' }) },
    config: { offPeak: OFF_PEAK },
    clock: () => at('2026-11-26T20:00:00+08:00'),
  })
  await scheduler.tick()
  const records = await ledger.records()
  assert.equal(records.filter((record) => record.type === 'task.claimed').length, 0, 'nothing dispatched at peak')
  scheduler.stop()
})

test('budget exhaustion stops dispatch and asks a human once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-budget-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })
  await ledger.append({ type: 'run.finished', runId: 'run-9', status: 'succeeded', tokens: 5_000_000, at: '2026-11-26T09:00:00+08:00' })

  const now = at('2026-11-26T10:00:00+08:00')
  const config = { dailyBudget: 1, costPerMToken: 0.28, offPeak: { ...OFF_PEAK, enabled: false } }
  assert.equal(budgetExhausted(await ledger.records(), { now, config }), true)

  const scheduler = new Scheduler({ ledger, executor: { run: async () => ({ status: 'succeeded' }) }, config, clock: () => now })
  await scheduler.tick()
  await scheduler.tick()

  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'todo', 'task not dispatched')
  assert.equal([...state.inbox.values()].filter((item) => item.key === 'budget' && item.status === 'open').length, 1)
  scheduler.stop()
})

test('tokens are summed per local day', async () => {
  const records = [
    { type: 'run.finished', tokens: 100, at: '2026-11-26T01:00:00+08:00' },
    { type: 'run.finished', tokens: 200, at: '2026-11-26T23:00:00+08:00' },
    { type: 'run.finished', tokens: 400, at: '2026-11-25T23:00:00+08:00' },
  ]
  assert.equal(tokensToday(records, { now: at('2026-11-26T12:00:00+08:00'), tz: 'Asia/Shanghai' }), 300)
})

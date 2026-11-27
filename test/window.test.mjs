import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOffPeak, shouldDefer, budgetExhausted, parseClock, tokensToday } from '../lib/window.js'
import { apply } from '../lib/index.js'

const OFF_PEAK = { enabled: true, start: '00:30', end: '08:30', tz: 'Asia/Shanghai' }
const at = (iso) => Date.parse(iso)

/** A window that certainly covers "now", expressed in the configured zone. */
function windowAroundNow(offsetMinutes) {
  const now = new Date(Date.now() + offsetMinutes * 60000)
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

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

test('crew_pull defers deferrable work outside the cheap window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-window-'))
  const tools = new Map()
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool) } } }
  // A window far from "now" so the task is certainly outside it.
  const outside = { enabled: true, start: windowAroundNow(180), end: windowAroundNow(240), tz: 'Asia/Shanghai' }
  apply(ctx, { dataDir: dir, offPeak: outside })

  await tools.get('crew_task_add').execute({ subject: '可延迟的活', type: 'monitor' })
  const peak = await tools.get('crew_pull').execute({})
  assert.equal(peak.jobs.length, 0)
  assert.deepEqual(peak.deferred, ['task-1'])

  await tools.get('crew_task_add').execute({ subject: '急活', type: 'monitor', priority: 100 })
  const urgent = await tools.get('crew_pull').execute({ limit: 5 })
  assert.equal(urgent.jobs.length, 1, 'urgent work ignores the window')
})

test('budget is a display figure, not a gate', async () => {
  const now = at('2026-11-26T10:00:00+08:00')
  const records = [{ type: 'run.finished', runId: 'run-9', status: 'succeeded', tokens: 5_000_000, at: '2026-11-26T09:00:00+08:00' }]
  assert.equal(budgetExhausted(records, { now, config: { dailyBudget: 1, costPerMToken: 0.28 } }), true)
  assert.equal(tokensToday(records, { now, tz: 'Asia/Shanghai' }), 5_000_000)
})

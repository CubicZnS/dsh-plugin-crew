import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOffPeak, budgetExhausted, parseClock, tokensToday } from '../lib/window.js'

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

test('budget is a display figure, not a gate', () => {
  const now = at('2026-11-26T10:00:00+08:00')
  const records = [{ type: 'run.finished', runId: 'run-9', status: 'succeeded', tokens: 5_000_000, at: '2026-11-26T09:00:00+08:00' }]
  assert.equal(budgetExhausted(records, { now, config: { dailyBudget: 1, costPerMToken: 0.28 } }), true)
  assert.equal(tokensToday(records, { now, tz: 'Asia/Shanghai' }), 5_000_000)
})

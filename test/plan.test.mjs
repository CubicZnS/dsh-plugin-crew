import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold } from '../lib/fold.js'
import { planTick, isLeaseExpired, isReady } from '../lib/plan.js'

const T0 = Date.parse('2026-11-26T10:00:00Z')
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString()

const base = () => [
  { type: 'task.created', at: at(0), taskId: 't1', subject: 'draft', writeScopes: ['docs/'] },
  { type: 'task.created', at: at(0), taskId: 't2', subject: 'blocked work', dependsOn: ['t1'] },
]

test('fold applies lifecycle transitions in order', () => {
  const state = fold([
    ...base(),
    { type: 'task.claimed', at: at(1000), taskId: 't1', owner: 'lead', leaseId: 'l1', expiresAt: T0 + 120000 },
    { type: 'task.completed', at: at(2000), taskId: 't1' },
  ])
  assert.equal(state.tasks.get('t1').status, 'done')
  assert.equal(state.leases.size, 0)
  assert.equal(state.tasks.get('t2').status, 'todo')
})

test('dependency gating follows completion', () => {
  const state = fold(base())
  assert.equal(isReady(state.tasks.get('t2'), state.tasks), false)
  state.tasks.get('t1').status = 'done'
  assert.equal(isReady(state.tasks.get('t2'), state.tasks), true)
})

test('an expired claim is reaped, a live one is not', () => {
  const state = fold([
    ...base(),
    { type: 'task.claimed', at: at(0), taskId: 't1', owner: 'lead', leaseId: 'l1', expiresAt: T0 + 60000 },
  ])
  assert.equal(isLeaseExpired(state.tasks.get('t1'), state.leases, T0 + 30000), false)
  assert.equal(isLeaseExpired(state.tasks.get('t1'), state.leases, T0 + 61000), true)
  const planned = planTick(state, { now: T0 + 61000 })
  assert.ok(planned.actions.some((action) => action.type === 'reap' && action.taskId === 't1'))
})

test('the planner never dispatches — that is the Lead\'s job', () => {
  const state = fold([{ type: 'task.created', at: at(0), taskId: 't1', subject: 'x' }])
  const planned = planTick(state, { now: T0 })
  assert.equal(planned.actions.filter((action) => action.type === 'dispatch').length, 0)
})

test('a wedged board escalates once, only after the configured stalls', () => {
  const state = fold([
    { type: 'task.created', at: at(0), taskId: 't1', subject: 'x' },
    { type: 'task.blocked', at: at(0), taskId: 't1', reason: 'needs-human' },
  ])
  assert.equal(planTick(state, { now: T0, stalledTicks: 1 }).actions.some((a) => a.type === 'deadlock'), false)
  assert.equal(planTick(state, { now: T0, stalledTicks: 3 }).actions.some((a) => a.type === 'deadlock'), true)
})

test('a board waiting on review is not deadlocked', () => {
  const state = fold([
    { type: 'task.created', at: at(0), taskId: 't1', subject: 'x' },
    { type: 'task.review.requested', at: at(0), taskId: 't1' },
  ])
  assert.equal(planTick(state, { now: T0, stalledTicks: 9 }).actions.some((a) => a.type === 'deadlock'), false)
})

test('idle passes back off instead of polling hard', () => {
  const state = fold([])
  assert.equal(planTick(state, { now: T0 }).nextTickMs, 300000)
})

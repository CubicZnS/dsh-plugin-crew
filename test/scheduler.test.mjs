import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { Scheduler } from '../lib/scheduler.js'
import { fold } from '../lib/fold.js'

async function fixture(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-wd-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  return { ledger, scheduler: new Scheduler({ ledger, config }) }
}

const claim = async (ledger, { taskId = 'task-1', leaseId = 'lease-1', expiresAt }) => {
  await ledger.append({ type: 'task.created', taskId, subject: 'x' })
  await ledger.append({ type: 'task.claimed', taskId, owner: 'lead', leaseId, expiresAt })
}

test('concurrent watchdog passes collapse into one', async () => {
  const { ledger, scheduler } = await fixture()
  await claim(ledger, { expiresAt: Date.now() - 1000 })
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])
  const releases = (await ledger.records()).filter((record) => record.type === 'task.released')
  assert.equal(releases.length, 1, 'one reap, not three')
  scheduler.stop()
})

test('an expired claim goes back to the board', async () => {
  const { ledger, scheduler } = await fixture()
  await claim(ledger, { expiresAt: Date.now() - 1000 })
  await scheduler.tick()
  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'todo')
  assert.equal(state.leases.size, 0)
  scheduler.stop()
})

test('reaping an exhausted task escalates instead of looping', async () => {
  const { ledger, scheduler } = await fixture({ maxAttempts: 1 })
  await claim(ledger, { expiresAt: Date.now() - 1000 })
  await ledger.append({ type: 'run.started', runId: 'run-1', taskId: 'task-1', kind: 'work' })
  await ledger.append({ type: 'run.reported', runId: 'run-1', status: 'failed', summary: 'boom' })
  await scheduler.tick()
  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'blocked')
  assert.equal([...state.inbox.values()].filter((item) => item.status === 'open').length, 1)
  scheduler.stop()
})

test('a live claim is left alone', async () => {
  const { ledger, scheduler } = await fixture()
  await claim(ledger, { expiresAt: Date.now() + 600000 })
  await scheduler.tick()
  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'claimed')
  assert.equal(state.leases.size, 1)
  scheduler.stop()
})

test('an unanswered approval expires into a blocked task', async () => {
  const { ledger, scheduler } = await fixture()
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })
  await ledger.append({ type: 'task.blocked', taskId: 'task-1', reason: 'retry-exhausted' })
  await ledger.append({ type: 'inbox.opened', inboxId: 'inbox-1', key: 'k', taskId: 'task-1', question: '批不批？', dueAt: Date.now() - 1000, timeoutAction: 'reject' })
  await scheduler.tick()
  const state = fold(await ledger.records())
  assert.equal(state.inbox.get('inbox-1').status, 'rejected')
  assert.equal(state.tasks.get('task-1').reason, 'approval-timeout')
  scheduler.stop()
})

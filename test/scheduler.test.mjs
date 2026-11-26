import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { Scheduler } from '../lib/scheduler.js'
import { ControlledExecutor } from '../lib/executor.js'
import { fold } from '../lib/fold.js'
import { checkInvariants } from '../lib/audit.js'

async function fixture(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  const executor = new ControlledExecutor()
  const scheduler = new Scheduler({ ledger, executor, config })
  return { ledger, executor, scheduler }
}

function seed(ledger, specs) {
  return Promise.all(specs.map((spec) => ledger.append({
    type: 'task.created',
    taskId: spec.id,
    subject: spec.subject ?? spec.id,
    writeScopes: spec.writeScopes ?? [],
    dependsOn: spec.dependsOn ?? [],
  })))
}

test('concurrent ticks never double-claim a task', async () => {
  const { ledger, scheduler } = await fixture()
  await seed(ledger, [{ id: 'task-1' }, { id: 'task-2' }])
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()])

  const records = await ledger.records()
  const claims = records.filter((record) => record.type === 'task.claimed')
  assert.equal(claims.length, 2)
  assert.equal(new Set(claims.map((claim) => claim.leaseId)).size, 2, 'lease ids must not collide within a tick')
  assert.equal(records.filter((record) => record.type === 'run.started').length, 2)
  assert.equal(scheduler.runningCount, 2)
  scheduler.stop()
})

test('restart reconciles an in-flight run before touching the board', async () => {
  const { ledger } = await fixture()
  await seed(ledger, [{ id: 'task-1' }])
  await ledger.append({ type: 'task.claimed', taskId: 'task-1', owner: 'worker', leaseId: 'lease-1', expiresAt: Date.now() + 60000 })
  await ledger.append({ type: 'run.started', runId: 'run-1', taskId: 'task-1', sessionId: 'dead-session' })

  const restarted = new Scheduler({ ledger, executor: new ControlledExecutor() })
  const interrupted = await restarted.recover()
  assert.deepEqual(interrupted, ['run-1'])

  const state = fold(await ledger.records())
  assert.equal(state.runs.get('run-1').status, 'interrupted')
  assert.equal(state.tasks.get('task-1').status, 'todo')
  assert.equal(state.leases.size, 0, 'orphaned lease must be released')

  await restarted.tick()
  assert.equal(restarted.runningCount, 1, 'recovered task is dispatched again')
  restarted.stop()
})

test('retries stop at maxAttempts and escalate to the inbox', async () => {
  const { ledger, executor, scheduler } = await fixture({ maxAttempts: 2 })
  await seed(ledger, [{ id: 'task-1' }])

  await scheduler.tick()
  await executor.finish(0, { status: 'failed', error: 'boom' })
  await scheduler.whenIdle()

  await scheduler.tick()
  await executor.finish(0, { status: 'failed', error: 'boom' })
  await scheduler.whenIdle()

  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'blocked')
  assert.equal(state.tasks.get('task-1').reason, 'retry-exhausted')
  const inbox = [...state.inbox.values()].filter((item) => item.status === 'open')
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].timeoutAction, 'reject')
  scheduler.stop()
})

test('one writer per write scope, even with free slots', async () => {
  const { ledger, executor, scheduler } = await fixture({ maxConcurrent: 4 })
  await seed(ledger, [{ id: 'task-1', writeScopes: ['src/'] }, { id: 'task-2', writeScopes: ['src/'] }])

  await scheduler.tick()
  assert.equal(scheduler.runningCount, 1, 'second task must wait for the same scope')

  await executor.finish(0, { status: 'succeeded' })
  await scheduler.whenIdle()
  await scheduler.tick()
  assert.equal(scheduler.runningCount, 1, 'scope is free again after completion')
  scheduler.stop()
})

test('a stalled board opens exactly one deadlock inbox item', async () => {
  const { ledger, scheduler } = await fixture({ deadlockTicks: 2 })
  await seed(ledger, [{ id: 'task-1', dependsOn: ['task-9'] }])

  for (let index = 0; index < 5; index += 1) await scheduler.tick()

  const state = fold(await ledger.records())
  const open = [...state.inbox.values()].filter((item) => item.status === 'open' && item.key === 'deadlock')
  assert.equal(open.length, 1)
  scheduler.stop()
})

test('happy path leaves no in-flight run and no lease behind', async () => {
  const { ledger, executor, scheduler } = await fixture()
  await seed(ledger, [{ id: 'task-1' }, { id: 'task-2' }])

  await scheduler.tick()
  await executor.finish(0, { status: 'succeeded', tokens: 10 })
  await executor.finish(0, { status: 'succeeded', tokens: 20 })
  await scheduler.whenIdle()

  const records = await ledger.records()
  const state = fold(records)
  assert.deepEqual([...state.tasks.values()].map((task) => task.status), ['done', 'done'])
  assert.equal(state.leases.size, 0)
  assert.equal(checkInvariants(records).ok, true)
  scheduler.stop()
})

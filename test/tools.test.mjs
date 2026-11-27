import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { apply } from '../lib/index.js'

function load(config) {
  const tools = new Map()
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool) } } }
  apply(ctx, config)
  return tools
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'crew-tools-'))
  return { dir, tools: load({ dataDir: dir }), ledger: new Ledger(join(dir, 'ledger.jsonl')) }
}

test('the plugin registers the whole tool surface', async () => {
  const { tools } = await fixture()
  assert.deepEqual([...tools.keys()].sort(), ['crew_inbox', 'crew_plan', 'crew_pull', 'crew_report', 'crew_status', 'crew_task_add', 'crew_task_cancel', 'crew_tasks'])
})

test('crew_report settles a real run and rejects malformed input', async () => {
  const { tools, ledger } = await fixture()
  const report = tools.get('crew_report')

  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x', taskType: 'monitor' })
  await ledger.append({ type: 'task.claimed', taskId: 'task-1', owner: 'lead', leaseId: 'lease-1', expiresAt: Date.now() + 60000 })
  await ledger.append({ type: 'run.started', runId: 'run-1', taskId: 'task-1', kind: 'work' })

  const good = await report.execute({ run_id: 'run-1', status: 'succeeded', summary: 'done', artifacts: ['src/a.js'] })
  assert.equal(good.ok, true)
  assert.equal(good.next, 'done', 'monitor tasks skip review')

  assert.equal((await report.execute({ run_id: '../../etc/passwd', status: 'succeeded' })).ok, false)
  assert.equal((await report.execute({ run_id: 'run-1', status: 'whatever' })).ok, false)
  assert.equal((await report.execute({ run_id: 'run-99', status: 'succeeded' })).ok, false, 'unknown run')

  const state = (await ledger.records()).reduce((acc, record) => {
    if (record.type === 'run.reported') acc.reported = record.runId
    if (record.type === 'task.completed') acc.completed = record.taskId
    return acc
  }, {})
  assert.equal(state.reported, 'run-1')
  assert.equal(state.completed, 'task-1')
})

test('crew_inbox lists open items and resolves them into transitions', async () => {
  const { tools, ledger } = await fixture()
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })
  await ledger.append({ type: 'task.blocked', taskId: 'task-1', reason: 'retry-exhausted' })
  await ledger.append({ type: 'inbox.opened', inboxId: 'inbox-1', key: 'k', taskId: 'task-1', question: '批不批？', dueAt: Date.now() + 60000, timeoutAction: 'reject' })

  const inbox = tools.get('crew_inbox')
  const listed = await inbox.execute({ action: 'list' })
  assert.equal(listed.items.length, 1)

  const resolved = await inbox.execute({ action: 'resolve', inbox_id: 'inbox-1', decision: 'approved' })
  assert.equal(resolved.ok, true)

  const state = (await ledger.records()).reduce((acc, record) => {
    if (record.type === 'inbox.resolved') acc.resolved = record.decision
    if (record.type === 'task.released') acc.released = record.taskId
    return acc
  }, {})
  assert.equal(state.resolved, 'approved')
  assert.equal(state.released, 'task-1')

  assert.equal((await inbox.execute({ action: 'list' })).items.length, 0)
})

test('crew_status reports counts and the next planned tick', async () => {
  const { tools, ledger } = await fixture()
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })
  const status = await tools.get('crew_status').execute({})
  assert.equal(status.ok, true)
  assert.equal(status.tasks.todo, 1)
  assert.deepEqual(status.nextActions, [])
  assert.deepEqual(status.pending, { work: 1, review: 0 })
})

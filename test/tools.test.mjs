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
  assert.deepEqual([...tools.keys()].sort(), ['crew_inbox', 'crew_plan', 'crew_report', 'crew_status', 'crew_tasks'])
})

test('crew_report is the completion channel and validates its input', async () => {
  const { tools, ledger } = await fixture()
  const report = tools.get('crew_report')

  const good = await report.execute({ run_id: 'run-3', status: 'succeeded', summary: 'done', artifacts: ['src/a.js'] })
  assert.equal(good.ok, true)

  assert.equal((await report.execute({ run_id: '../../etc/passwd', status: 'succeeded' })).ok, false)
  assert.equal((await report.execute({ run_id: 'run-3', status: 'whatever' })).ok, false)

  const records = await ledger.records()
  const reports = records.filter((record) => record.type === 'run.reported')
  assert.equal(reports.length, 1)
  assert.equal(reports[0].runId, 'run-3')
  assert.deepEqual(reports[0].artifacts, ['src/a.js'])
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
  assert.deepEqual(status.nextActions, ['dispatch'])
})

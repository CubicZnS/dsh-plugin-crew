import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { apply } from '../lib/index.js'
import { fold } from '../lib/fold.js'

async function fixture(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-pull-'))
  const tools = new Map()
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool) } } }
  apply(ctx, { enabled: true, dataDir: dir, offPeak: { enabled: false }, ...config })
  return { tools, ledger: new Ledger(join(dir, 'ledger.jsonl')) }
}

const add = (tools, args) => tools.get('crew_task_add').execute(args)
const pull = (tools, args = {}) => tools.get('crew_pull').execute(args)
const report = (tools, args) => tools.get('crew_report').execute(args)
const statusOf = async (ledger, id) => fold(await ledger.records()).tasks.get(id)?.status

test('pull hands out a work job once and never double-claims', async () => {
  const { tools } = await fixture()
  const created = await add(tools, { subject: '写个函数', type: 'monitor' })
  assert.equal(created.taskId, 'task-1')

  const first = await pull(tools, { limit: 2 })
  assert.equal(first.jobs.length, 1)
  assert.equal(first.jobs[0].kind, 'work')
  assert.match(first.jobs[0].prompt, /crew_report/)
  assert.match(first.jobs[0].prompt, new RegExp(first.jobs[0].runId))

  const second = await pull(tools, { limit: 2 })
  assert.equal(second.jobs.length, 0, 'claimed work is not handed out twice')
})

test('code work goes to blind review before it is done', async () => {
  const { tools, ledger } = await fixture()
  await add(tools, { subject: '改个 bug', type: 'code' })

  const work = (await pull(tools)).jobs[0]
  await report(tools, { run_id: work.runId, status: 'succeeded', summary: '改好了', artifacts: ['src/a.js'] })
  assert.equal(await statusOf(ledger, 'task-1'), 'review')

  const review = (await pull(tools)).jobs[0]
  assert.equal(review.kind, 'review')
  assert.match(review.prompt, /盲审/)

  await report(tools, { run_id: review.runId, status: 'succeeded', summary: '符合标准' })
  assert.equal(await statusOf(ledger, 'task-1'), 'done')
})

test('a rejected review sends the task back exactly once more', async () => {
  const { tools, ledger } = await fixture({ maxAttempts: 2 })
  await add(tools, { subject: 'x', type: 'code' })

  const work = (await pull(tools)).jobs[0]
  await report(tools, { run_id: work.runId, status: 'succeeded' })
  const review = (await pull(tools)).jobs[0]
  await report(tools, { run_id: review.runId, status: 'failed', summary: '缺测试' })

  const task = fold(await ledger.records()).tasks.get('task-1')
  assert.equal(task.status, 'todo')
  assert.equal(task.failures, 1)
})

test('failures exhaust into the inbox instead of looping forever', async () => {
  const { tools, ledger } = await fixture({ maxAttempts: 2 })
  await add(tools, { subject: 'x', type: 'monitor' })

  const first = (await pull(tools)).jobs[0]
  await report(tools, { run_id: first.runId, status: 'failed', summary: 'boom' })
  const second = (await pull(tools)).jobs[0]
  await report(tools, { run_id: second.runId, status: 'failed', summary: 'boom again' })

  const state = fold(await ledger.records())
  assert.equal(state.tasks.get('task-1').status, 'blocked')
  assert.equal(state.tasks.get('task-1').reason, 'retry-exhausted')
  const inbox = await tools.get('crew_inbox').execute({ action: 'list' })
  assert.equal(inbox.items.length, 1)
})

test('blocked work asks a human instead of retrying', async () => {
  const { tools, ledger } = await fixture()
  await add(tools, { subject: 'x', type: 'monitor' })
  const job = (await pull(tools)).jobs[0]
  await report(tools, { run_id: job.runId, status: 'blocked', summary: '需要 API key' })

  assert.equal(await statusOf(ledger, 'task-1'), 'blocked')
  const inbox = await tools.get('crew_inbox').execute({ action: 'list' })
  assert.equal(inbox.items.length, 1)
  assert.match(inbox.items[0].question, /卡住/)
})

test('dependencies and write scopes gate the pull', async () => {
  const { tools } = await fixture()
  await add(tools, { subject: 'a', type: 'monitor', writeScopes: ['src/'] })
  await add(tools, { subject: 'b', type: 'monitor', writeScopes: ['src/'], dependsOn: ['task-1'] })

  const first = await pull(tools, { limit: 5 })
  assert.equal(first.jobs.length, 1, 'same scope + unmet dependency')
})
test('a task can be canceled, and a canceled task is never handed out', async () => {
  const { tools, ledger } = await fixture()
  const created = await add(tools, { subject: '别做了', type: 'monitor' })
  const canceled = await tools.get('crew_task_cancel').execute({ task_id: created.taskId, reason: '需求变了' })
  assert.equal(canceled.ok, true)
  assert.equal(await statusOf(ledger, created.taskId), 'canceled')
  assert.equal((await pull(tools)).jobs.length, 0)
})

test('a finished task cannot be canceled', async () => {
  const { tools } = await fixture()
  await add(tools, { subject: 'x', type: 'monitor' })
  const job = (await pull(tools)).jobs[0]
  await report(tools, { run_id: job.runId, status: 'succeeded' })
  const result = await tools.get('crew_task_cancel').execute({ task_id: 'task-1' })
  assert.equal(result.ok, false)
})

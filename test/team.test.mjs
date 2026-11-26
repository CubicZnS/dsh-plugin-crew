import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { fold } from '../lib/fold.js'
import { Scheduler } from '../lib/scheduler.js'
import { TeamExecutor, workPrompt, reviewPrompt } from '../lib/team-executor.js'
import { kindOf, requiresReview, rubricFor, listKinds } from '../lib/kinds.js'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

class FakeTeam {
  constructor(ledger) {
    this.ledger = ledger
    this.sent = []
    this.workers = new Set()
    this.permissions = []
  }

  setPermission(name, presetId) {
    this.permissions.push({ name, presetId })
    return true
  }

  async ensureWorker(name) { this.workers.add(name) }

  async dispatch(name, text) {
    this.sent.push({ name, text })
    return 'accepted'
  }

  report(runId, status, summary) {
    return this.ledger.append({ type: 'run.reported', runId, status, summary, tokens: 100 })
  }
}

async function fixture(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-team-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  const team = new FakeTeam(ledger)
  const executor = new TeamExecutor({ ledger, team, pollMs: 5, timeoutMs: config.timeoutMs ?? 2000, ...config })
  return { ledger, team, executor }
}

const task = (overrides = {}) => ({ id: 'task-1', subject: '写个东西', type: 'code', writeScopes: ['src/'], ...overrides })

test('kind registry carries permission, rubric and review policy', () => {
  assert.equal(kindOf('research').permissionPreset, 'read-only')
  assert.equal(kindOf('code').review, true)
  assert.equal(requiresReview('monitor'), false)
  assert.equal(rubricFor('code').split('\n').length, 3)
  assert.deepEqual(listKinds().map((kind) => kind.id), ['code', 'research', 'content', 'monitor'])
  assert.equal(kindOf('nonsense').label, kindOf('code').label)
})

test('work prompt carries run id, write scopes and the reporting contract', () => {
  const text = workPrompt({ task: task(), runId: 'run-7', attempt: 2 })
  assert.match(text, /run-7/u)
  assert.match(text, /src\//u)
  assert.match(text, /crew_report/u)
  assert.match(text, /第 2 次执行/u)
})

test('review prompt is blind: no worker transcript, rubric only', () => {
  const text = reviewPrompt({ task: task(), reviewId: 'run-7-r' })
  assert.match(text, /run-7-r/u)
  assert.match(text, /看不到执行者的对话/u)
  assert.equal(text.includes('worker said'), false)
})

test('the permission tier is applied from the task kind before dispatch', async () => {
  const { team, executor } = await fixture()
  const code = executor.run(task({ type: 'code' }), { runId: 'run-1' })
  await sleep(10)
  await team.report('run-1', 'succeeded', 'ok')
  await sleep(10)
  await team.report('run-1-r', 'succeeded', 'ok')
  await code
  assert.equal(team.permissions[0].presetId, 'workspace-write')

  const research = executor.run(task({ id: 'task-2', type: 'research' }), { runId: 'run-2' })
  await sleep(10)
  await team.report('run-2', 'succeeded', 'ok')
  await sleep(10)
  await team.report('run-2-r', 'succeeded', 'ok')
  await research
  assert.equal(team.permissions[1].presetId, 'read-only')
})

test('executor resolves when the worker reports success', async () => {
  const { team, executor } = await fixture()
  const running = executor.run(task({ type: 'monitor' }), { runId: 'run-1' })
  await sleep(20)
  await team.report('run-1', 'succeeded', 'done')
  assert.deepEqual(await running, { status: 'succeeded', tokens: 100, summary: 'done' })
})

test('a failed report becomes a failed run with the summary as the error', async () => {
  const { team, executor } = await fixture()
  const running = executor.run(task({ type: 'monitor' }), { runId: 'run-1' })
  await sleep(20)
  await team.report('run-1', 'failed', 'tests still red')
  const result = await running
  assert.equal(result.status, 'failed')
  assert.match(result.error, /tests still red/u)
})

test('code tasks get a blind review; a rejection fails the run', async () => {
  const { ledger, team, executor } = await fixture()
  const running = executor.run(task(), { runId: 'run-1' })
  await sleep(20)
  await team.report('run-1', 'succeeded', 'wrote it')
  await sleep(20)
  assert.equal(team.sent.length, 2, 'worker then reviewer')
  assert.equal(team.sent[1].name, 'reviewer')
  await team.report('run-1-r', 'failed', '第 2 条不满足：没有测试')
  const result = await running
  assert.equal(result.status, 'failed')
  assert.match(result.error, /review-rejected/u)
  const verdict = (await ledger.records()).find((record) => record.type === 'review.verdict')
  assert.equal(verdict.verdict, 'fail')
})

test('a passing review finishes the run', async () => {
  const { team, executor } = await fixture()
  const running = executor.run(task(), { runId: 'run-1' })
  await sleep(20)
  await team.report('run-1', 'succeeded', 'wrote it')
  await sleep(20)
  await team.report('run-1-r', 'succeeded', 'looks right')
  assert.equal((await running).status, 'succeeded')
})

test('no report within the timeout is a timed_out run', async () => {
  const { executor } = await fixture({ timeoutMs: 40 })
  const result = await executor.run(task({ type: 'monitor' }), { runId: 'run-9' })
  assert.equal(result.status, 'timed_out')
})

test('an unanswered approval expires into a blocked task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-inbox-'))
  const ledger = new Ledger(join(dir, 'ledger.jsonl'))
  await ledger.append({ type: 'task.created', taskId: 'task-1', subject: 'x' })
  await ledger.append({ type: 'inbox.opened', inboxId: 'inbox-1', key: 'manual', taskId: 'task-1', question: '批不批？', dueAt: Date.now() - 1000, timeoutAction: 'reject' })

  const scheduler = new Scheduler({ ledger, executor: { run: async () => ({ status: 'succeeded' }) } })
  await scheduler.tick()

  const state = fold(await ledger.records())
  assert.equal(state.inbox.get('inbox-1').status, 'rejected')
  assert.equal(state.tasks.get('task-1').status, 'blocked')
  assert.equal(state.tasks.get('task-1').reason, 'approval-timeout')
  scheduler.stop()
})

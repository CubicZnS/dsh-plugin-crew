import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPanel } from '../lib/panel.js'

const base = [
  { type: 'task.created', at: '2026-11-27T00:46:36.345Z', taskId: 'task-1', subject: '统计行数', taskType: 'monitor', writeScopes: ['data/'] },
  { type: 'task.claimed', at: '2026-11-27T00:58:52.419Z', taskId: 'task-1', owner: 'lead' },
  { type: 'run.started', at: '2026-11-27T00:58:52.421Z', runId: 'run-1', taskId: 'task-1', kind: 'work', prompt: '[crew] 任务 task-1（run run-1）\n目标：统计行数' },
  { type: 'run.reported', at: '2026-11-27T00:59:01.824Z', runId: 'run-1', status: 'succeeded', summary: 'README 行数 = 82', artifacts: ['README.md'] },
  { type: 'task.completed', at: '2026-11-27T00:59:01.824Z', taskId: 'task-1' },
]

test('the panel shows the handoff and the report — the agent conversation', () => {
  const html = renderPanel(base, { ledgerPath: '/tmp/ledger.jsonl' })
  assert.match(html, /Lead →worker/u)
  assert.match(html, /worker → Lead/u)
  assert.match(html, /目标：统计行数/u)
  assert.match(html, /README 行数 = 82/u)
  assert.match(html, /succeeded/u)
})

test('counts and status pills reflect the ledger', () => {
  const html = renderPanel(base, {})
  assert.match(html, /<b class="ok">1<\/b><span>完成<\/span>/u)
  assert.match(html, /pill ok">done/u)
})

test('an empty ledger still renders a usable page', () => {
  const html = renderPanel([], {})
  assert.match(html, /账本还是空的/u)
  assert.match(html, /<\/html>/u)
})

test('a run without a recorded prompt degrades honestly', () => {
  const html = renderPanel([base[0], { type: 'run.started', at: base[2].at, runId: 'run-9', taskId: 'task-1', kind: 'work' }], {})
  assert.match(html, /没有记录提示词/u)
})

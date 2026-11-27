import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPanel, summarize } from '../lib/panel.js'

const base = [
  { type: 'task.created', at: '2026-11-27T00:46:36.345Z', taskId: 'task-1', subject: '统计行数', taskType: 'monitor', writeScopes: ['data/'] },
  { type: 'task.claimed', at: '2026-11-27T00:58:52.419Z', taskId: 'task-1', owner: 'lead' },
  { type: 'run.started', at: '2026-11-27T00:58:52.421Z', runId: 'run-1', taskId: 'task-1', kind: 'work', prompt: '[crew] 任务 task-1（run run-1）\n目标：统计行数' },
  { type: 'run.reported', at: '2026-11-27T00:59:01.824Z', runId: 'run-1', status: 'succeeded', headline: 'README 共 82 行，未改动文件', summary: '/Users/a/b/README.md 的 wc -l 是 82\nsha256 前后一致', artifacts: ['README.md'] },
  { type: 'task.completed', at: '2026-11-27T00:59:01.824Z', taskId: 'task-1' },
]

test('the turn shows a one-line summary, not the raw transcript', () => {
  const html = renderPanel(base, {})
  assert.match(html, /Lead → worker/u)
  assert.match(html, /worker → Lead/u)
  assert.match(html, /README 共 82 行，未改动文件/u, 'headline is the visible line')
  assert.match(html, /统计行数/u, 'outbound is summarized as the task subject')
  assert.match(html, /<details class="raw"><summary>原文<\/summary>/u, 'raw text lives behind a toggle')
})

test('file paths stay inside the collapsed raw block', () => {
  const html = renderPanel(base, {})
  const visible = html.split('<details')[0]
  assert.equal(visible.includes('/Users/a/b/README.md'), false, 'no paths in the summary view')
  assert.equal(html.includes('/Users/a/b/README.md'), true, 'but they are still available')
})

test('summarize keeps one short sentence', () => {
  assert.equal(summarize('第一句。第二句。'), '第一句。')
  assert.equal(summarize('  a\n\n b  '), 'a b')
  assert.equal(summarize('x'.repeat(100), 20).length, 20)
  assert.equal(summarize(''), '')
})

test('a run without a headline falls back to the first sentence of the summary', () => {
  const html = renderPanel([base[0], { type: 'run.started', at: base[2].at, runId: 'run-9', taskId: 'task-1', kind: 'work' }, { type: 'run.reported', at: base[3].at, runId: 'run-9', status: 'succeeded', summary: '改完了。细节很多。' }], {})
  assert.match(html, /改完了。/u)
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

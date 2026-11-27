import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPanel, summarize } from '../lib/panel.js'

const base = [
  { type: 'task.created', at: '2026-11-27T00:46:36.345Z', taskId: 'task-1', subject: '统计行数', taskType: 'monitor', writeScopes: ['data/'] },
  { type: 'task.claimed', at: '2026-11-27T00:58:52.419Z', taskId: 'task-1', owner: 'lead' },
  { type: 'run.started', at: '2026-11-27T00:58:52.421Z', runId: 'run-1', taskId: 'task-1', kind: 'work', prompt: '[crew] 任务 task-1（run run-1）\n目标：统计行数' },
  { type: 'run.reported', at: '2026-11-27T00:59:01.824Z', runId: 'run-1', status: 'succeeded', headline: 'README 共 82 行，未改动文件', summary: '/Users/a/b/README.md 的 wc -l 是 82', artifacts: ['README.md'] },
  { type: 'task.completed', at: '2026-11-27T00:59:01.824Z', taskId: 'task-1' },
]

test('the ledger becomes a chat: bubbles with senders and badges', () => {
  const html = renderPanel(base, {})
  assert.match(html, /<h2>群聊<\/h2>/u)
  assert.match(html, /class="bubble/u)
  assert.match(html, /<b>你<\/b>/u, 'the task was added by the human')
  assert.match(html, /<b>Lead<\/b>/u, 'the lead handed it off')
  assert.match(html, /<b>worker<\/b>/u, 'the worker reported back')
  assert.match(html, /class="badge">派活/u)
  assert.match(html, /class="badge">回报/u)
})

test('mentions are highlighted', () => {
  const html = renderPanel(base, {})
  assert.match(html, /class="mention">@worker/u)
})

test('bubbles carry summaries, not raw paths', () => {
  const html = renderPanel(base, {})
  const chat = html.split('<h2>任务<\/h2>')[0]
  assert.equal(chat.includes('/Users/a/b/README.md'), false)
  assert.match(chat, /README 共 82 行，未改动文件/u)
})

test('an explicit message and a user reply appear as bubbles', () => {
  const html = renderPanel([
    { type: 'message.sent', at: '2026-11-27T01:00:00Z', messageId: 'msg-1', from: 'lead', to: ['worker'], text: '@worker 先跑一遍测试再改' },
    { type: 'message.sent', at: '2026-11-27T01:01:00Z', messageId: 'msg-2', from: 'user', to: ['lead'], text: '别动 src/auth' },
  ], {})
  assert.match(html, /class="mention">@worker<\/span> 先跑一遍测试再改/u)
  assert.match(html, /msg-row me/u, 'the user message is right-aligned')
  assert.equal(html.includes('别动 src/auth'), true)
})

test('summarize keeps one short sentence', () => {
  assert.equal(summarize('第一句。第二句。'), '第一句。')
  assert.equal(summarize('x'.repeat(100), 20).length, 20)
})

test('an empty ledger still renders a usable page', () => {
  const html = renderPanel([], {})
  assert.match(html, /还没有消息/u)
  assert.match(html, /<\/html>/u)
})

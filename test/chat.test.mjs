import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMessages, mentionsIn, renderMentions } from '../lib/chat.js'

test('every coordination record becomes a message with a sender', () => {
  const messages = deriveMessages([
    { type: 'task.created', at: 't1', taskId: 'task-1', subject: '统计行数' },
    { type: 'run.started', at: 't2', taskId: 'task-1', runId: 'run-1', kind: 'work' },
    { type: 'run.reported', at: 't3', runId: 'run-1', taskId: 'task-1', status: 'succeeded', headline: '82 行' },
    { type: 'review.verdict', at: 't4', taskId: 'task-1', verdict: 'fail', notes: '缺测试' },
  ])
  assert.deepEqual(messages.map((m) => m.from), ['user', 'lead', 'worker', 'reviewer'])
  assert.equal(messages[1].text, '派活 @worker：统计行数')
  assert.deepEqual(messages[1].mentions, ['worker'])
  assert.equal(messages[2].text, '82 行')
  assert.match(messages[3].text, /驳回/u)
})

test('a review handoff mentions the reviewer, not the worker', () => {
  const messages = deriveMessages([
    { type: 'task.created', at: 't1', taskId: 'task-1', subject: 'x' },
    { type: 'run.started', at: 't2', taskId: 'task-1', runId: 'run-1-r', kind: 'review' },
  ])
  assert.match(messages[1].text, /@reviewer/u)
})

test('explicit messages keep their identity and order', () => {
  const messages = deriveMessages([
    { type: 'message.sent', at: 't1', messageId: 'msg-7', from: 'lead', to: ['worker'], text: '@worker 先跑测试' },
  ])
  assert.equal(messages[0].id, 'msg-7')
  assert.equal(messages[0].from, 'lead')
  assert.deepEqual(messages[0].mentions, ['worker'])
})

test('mentions are extracted and escaped when rendered', () => {
  assert.deepEqual(mentionsIn('@worker 和 @reviewer 看一下'), ['worker', 'reviewer'])
  assert.deepEqual(mentionsIn('没有 at'), [])
  assert.equal(renderMentions('<b>@lead</b>'), '&lt;b&gt;<span class="mention">@lead</span>&lt;/b&gt;')
})

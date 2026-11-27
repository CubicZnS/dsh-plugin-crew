import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kindOf, requiresReview, rubricFor, listKinds } from '../lib/kinds.js'
import { workJobPrompt, reviewJobPrompt } from '../lib/handoff.js'

const task = (overrides = {}) => ({ id: 'task-1', subject: '写个东西', type: 'code', writeScopes: ['src/'], ...overrides })

test('kind registry carries permission, rubric and review policy', () => {
  assert.equal(kindOf('research').permissionPreset, 'read-only')
  assert.equal(kindOf('code').review, true)
  assert.equal(requiresReview('monitor'), false)
  assert.equal(rubricFor('code').split('\n').length, 3)
  assert.deepEqual(listKinds().map((kind) => kind.id), ['code', 'research', 'content', 'monitor'])
  assert.equal(kindOf('nonsense').label, kindOf('code').label)
})

test('work job prompt carries run id, write scopes and the reporting contract', () => {
  const text = workJobPrompt({ task: task(), runId: 'run-7' })
  assert.match(text, /run-7/u)
  assert.match(text, /src\//u)
  assert.match(text, /crew_report/u)
  assert.match(text, /写域/u)
})

test('review job prompt is blind: rubric only, no worker transcript', () => {
  const text = reviewJobPrompt({ task: task(), runId: 'run-7-r', artifacts: ['src/a.js'] })
  assert.match(text, /run-7-r/u)
  assert.match(text, /看不到执行者的对话/u)
  assert.match(text, /src\/a\.js/u)
})

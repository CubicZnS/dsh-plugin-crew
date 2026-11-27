/**
 * Fold the append-only ledger into current state. Pure; no I/O.
 */
export function emptyState() {
  return { tasks: new Map(), runs: new Map(), leases: new Map(), inbox: new Map(), corrupt: 0 }
}

export function fold(records) {
  const state = emptyState()
  for (const record of records) applyRecord(state, record)
  return state
}

function taskOf(state, id) {
  let task = state.tasks.get(id)
  if (!task) {
    task = { id, status: 'unknown', owner: undefined, writeScopes: [], dependsOn: [], attempts: 0, failures: 0 }
    state.tasks.set(id, task)
  }
  return task
}

function dropLeases(state, taskId) {
  for (const [id, lease] of state.leases) {
    if (lease.taskId === taskId) state.leases.delete(id)
  }
}

function applyRecord(state, record) {
  if (!record || typeof record.type !== 'string') {
    state.corrupt += 1
    return
  }
  switch (record.type) {
    case 'task.created': {
      const task = taskOf(state, record.taskId)
      task.status = 'todo'
      task.subject = record.subject
      task.type = record.taskType
      task.priority = record.priority ?? 0
      task.writeScopes = record.writeScopes ?? []
      task.dependsOn = record.dependsOn ?? []
      task.acceptance = record.acceptance
      task.createdAt = record.at
      break
    }
    case 'task.claimed': {
      const task = taskOf(state, record.taskId)
      task.status = 'claimed'
      task.owner = record.owner
      task.claimedAt = record.at
      task.attempts += 1
      if (record.leaseId) {
        state.leases.set(record.leaseId, {
          id: record.leaseId,
          taskId: record.taskId,
          owner: record.owner,
          expiresAt: record.expiresAt,
        })
      }
      break
    }
    case 'task.released': {
      const task = taskOf(state, record.taskId)
      task.status = 'todo'
      task.owner = undefined
      dropLeases(state, task.id)
      break
    }
    case 'task.completed': {
      const task = taskOf(state, record.taskId)
      task.status = 'done'
      task.owner = undefined
      task.finishedAt = record.at
      dropLeases(state, task.id)
      break
    }
    case 'task.failed': {
      const task = taskOf(state, record.taskId)
      task.status = 'failed'
      task.owner = undefined
      task.error = record.error
      task.finishedAt = record.at
      dropLeases(state, task.id)
      break
    }
    case 'task.canceled': {
      const task = taskOf(state, record.taskId)
      task.status = 'canceled'
      task.cancelReason = record.reason
      task.owner = undefined
      dropLeases(state, task.id)
      break
    }
    case 'task.blocked': {
      const task = taskOf(state, record.taskId)
      task.status = 'blocked'
      task.reason = record.reason
      task.owner = undefined
      dropLeases(state, task.id)
      break
    }
    case 'lease.renewed': {
      const lease = state.leases.get(record.leaseId)
      if (lease) lease.expiresAt = record.expiresAt
      break
    }
    case 'task.review.requested': {
      const task = taskOf(state, record.taskId)
      task.status = 'review'
      task.reviewRequestedAt = record.at
      task.owner = undefined
      dropLeases(state, task.id)
      break
    }
    case 'review.verdict': {
      const task = taskOf(state, record.taskId)
      if (record.verdict === 'pass') {
        task.status = 'done'
        task.finishedAt = record.at
      } else {
        task.status = 'todo'
        task.failures = (task.failures ?? 0) + 1
      }
      task.lastVerdict = record.verdict
      task.lastReviewNotes = record.notes
      break
    }
    case 'run.started': {
      state.runs.set(record.runId, {
        id: record.runId,
        taskId: record.taskId,
        sessionId: record.sessionId,
        startedAt: record.at,
        status: 'running',
        attempt: record.attempt,
        kind: record.kind ?? 'work',
        prompt: record.prompt,
      })
      break
    }
    case 'run.finished': {
      const run = state.runs.get(record.runId)
      const wasRunning = run !== undefined && run.status === 'running'
      if (run) {
        run.status = record.status
        run.finishedAt = record.at
        run.error = record.error
        run.tokens = record.tokens
      }
      // Only real failures spend the retry budget; a host crash is not the task's fault.
      if (wasRunning && (record.status === 'failed' || record.status === 'timed_out')) {
        const task = state.tasks.get(run.taskId)
        if (task) task.failures = (task.failures ?? 0) + 1
      }
      break
    }
    case 'run.reported': {
      const run = state.runs.get(record.runId)
      if (!run) break
      run.status = record.status
      run.reportedAt = record.at
      run.summary = record.summary
      run.artifacts = record.artifacts ?? []
      if (Number.isFinite(record.tokens)) run.tokens = record.tokens
      // Work reports are the only failure signal in pull mode (no run.finished).
      if (run.kind === 'work' && record.status === 'failed') {
        const task = state.tasks.get(run.taskId)
        if (task) task.failures = (task.failures ?? 0) + 1
      }
      break
    }
    case 'inbox.opened': {
      state.inbox.set(record.inboxId, {
        id: record.inboxId,
        key: record.key,
        taskId: record.taskId,
        question: record.question,
        status: 'open',
        dueAt: record.dueAt,
        timeoutAction: record.timeoutAction,
      })
      break
    }
    case 'inbox.resolved': {
      const item = state.inbox.get(record.inboxId)
      if (item) {
        item.status = record.decision
        item.resolvedAt = record.at
      }
      break
    }
    default:
      break
  }
}

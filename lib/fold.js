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
    task = { id, status: 'unknown', owner: undefined, writeScopes: [], dependsOn: [], attempts: 0 }
    state.tasks.set(id, task)
  }
  return task
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
      task.writeScopes = record.writeScopes ?? []
      task.dependsOn = record.dependsOn ?? []
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
      if (record.leaseId) state.leases.delete(record.leaseId)
      break
    }
    case 'task.completed': {
      const task = taskOf(state, record.taskId)
      task.status = 'done'
      task.owner = undefined
      task.finishedAt = record.at
      if (record.leaseId) state.leases.delete(record.leaseId)
      break
    }
    case 'task.failed': {
      const task = taskOf(state, record.taskId)
      task.status = 'failed'
      task.owner = undefined
      task.error = record.error
      if (record.leaseId) state.leases.delete(record.leaseId)
      break
    }
    case 'task.blocked': {
      const task = taskOf(state, record.taskId)
      task.status = 'blocked'
      task.reason = record.reason
      break
    }
    case 'lease.renewed': {
      const lease = state.leases.get(record.leaseId)
      if (lease) lease.expiresAt = record.expiresAt
      break
    }
    case 'run.started': {
      state.runs.set(record.runId, {
        id: record.runId,
        taskId: record.taskId,
        sessionId: record.sessionId,
        startedAt: record.at,
        status: 'running',
      })
      break
    }
    case 'run.finished': {
      const run = state.runs.get(record.runId)
      if (run) {
        run.status = record.status
        run.finishedAt = record.at
        run.error = record.error
        run.tokens = record.tokens
      }
      break
    }
    case 'inbox.opened': {
      state.inbox.set(record.inboxId, {
        id: record.inboxId,
        taskId: record.taskId,
        question: record.question,
        status: 'open',
        dueAt: record.dueAt,
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

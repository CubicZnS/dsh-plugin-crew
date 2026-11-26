/**
 * Cheap, ledger-only invariants. Used by tests and by the daemon's summary so a
 * long unattended run can prove it never double-dispatched a task.
 */
export function checkInvariants(records) {
  const inflight = new Map()
  const issues = []
  const runs = new Map()

  for (const record of records) {
    if (record.type === 'run.started') {
      runs.set(record.runId, record.taskId)
      if (inflight.has(record.taskId)) {
        issues.push('task ' + record.taskId + ' had two concurrent runs (' + inflight.get(record.taskId) + ', ' + record.runId + ')')
      }
      inflight.set(record.taskId, record.runId)
    } else if (record.type === 'run.finished') {
      for (const [taskId, runId] of inflight) {
        if (runId === record.runId) inflight.delete(taskId)
      }
    }
  }

  return {
    ok: issues.length === 0 && inflight.size === 0,
    issues,
    inflight: [...inflight].map(([taskId, runId]) => ({ taskId, runId })),
  }
}

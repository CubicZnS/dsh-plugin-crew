/**
 * Watchdog planner. Pure: no I/O, no timers, no dispatch.
 *
 * Dispatch is not this plugin's job — the Lead pulls work through crew_pull.
 * What remains here is what only a background loop can do: notice that a claim
 * has gone stale, that nothing has moved in a while, or that the board is wedged.
 */
export const DEFAULTS = {
  tickMs: 60000,
  idleTickMs: 300000,
  leaseTtlMs: 1800000,
  maxAttempts: 2,
  deadlockTicks: 3,
  auditAfterMs: 900000,
  inboxTtlMs: 14400000,
  inboxTimeout: 'reject',
}

/** A claimed task whose lease is missing or past its expiry. */
export function isLeaseExpired(task, leases, now) {
  if (task.status !== 'claimed') return false
  const lease = [...leases.values()].find((item) => item.taskId === task.id)
  return !lease || lease.expiresAt <= now
}

/** Dependencies satisfied when every dependency is done. */
export function isReady(task, tasks) {
  return (task.dependsOn ?? []).every((id) => tasks.get(id)?.status === 'done')
}

/**
 * Plan one watchdog pass.
 * @returns {{ actions: object[], nextTickMs: number }}
 */
export function planTick(state, { now, config = {}, stalledTicks = 0 }) {
  const cfg = { ...DEFAULTS, ...config }
  const tasks = [...state.tasks.values()]
  const actions = []

  for (const task of tasks) {
    if (!isLeaseExpired(task, state.leases, now)) continue
    actions.push({ type: 'reap', taskId: task.id, owner: task.owner, reason: 'lease-expired' })
  }

  const live = tasks.filter((task) => task.status === 'claimed' && !isLeaseExpired(task, state.leases, now))
  for (const task of live) {
    const age = now - Date.parse(task.claimedAt ?? new Date(now).toISOString())
    if (Number.isFinite(age) && age > cfg.auditAfterMs) actions.push({ type: 'audit', taskId: task.id, ageMs: age })
  }

  const open = tasks.filter((task) => !['done', 'failed', 'canceled'].includes(task.status))
  const pullable = tasks.filter((task) => task.status === 'todo' && isReady(task, state.tasks)
    && (task.failures ?? 0) < cfg.maxAttempts)
  const underReview = tasks.filter((task) => task.status === 'review')
  if (open.length > 0 && pullable.length === 0 && underReview.length === 0 && live.length === 0
    && stalledTicks >= cfg.deadlockTicks) {
    actions.push({ type: 'deadlock', taskIds: open.map((task) => task.id) })
  }

  const idle = live.length === 0 && pullable.length === 0 && underReview.length === 0
  return { actions, nextTickMs: idle ? cfg.idleTickMs : cfg.tickMs }
}

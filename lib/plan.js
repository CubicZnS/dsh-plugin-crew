/**
 * Pure planning: given folded state and a tick context, decide what to do next.
 * No I/O, no timers, no model calls — everything is assertable in unit tests.
 */
export const DEFAULTS = {
  tickMs: 60000,
  idleTickMs: 300000,
  leaseTtlMs: 1800000,
  leaseRenewMs: 300000,
  maxConcurrent: 4,
  maxAttempts: 2,
  deadlockTicks: 3,
  inboxTtlMs: 14400000,
  inboxTimeout: 'reject',
}

/** True when a claimed task's lease is missing or past its expiry. */
export function isLeaseExpired(task, leases, now) {
  if (task.status !== 'claimed') return false
  const lease = [...leases.values()].find((item) => item.taskId === task.id)
  return !lease || lease.expiresAt <= now
}

/** Dependencies satisfied when every dependency is done (missing dep counts as unmet). */
export function isReady(task, tasks) {
  return (task.dependsOn ?? []).every((id) => tasks.get(id)?.status === 'done')
}

/**
 * Plan one tick.
 * @returns {{ actions: object[], nextTickMs: number }}
 */
export function planTick(state, { now, config = {}, runningCount = 0, stalledTicks = 0 }) {
  const cfg = { ...DEFAULTS, ...config }
  const actions = []
  const tasks = [...state.tasks.values()]

  // 1. reap — leases that lapsed while a run was open
  for (const task of tasks) {
    if (isLeaseExpired(task, state.leases, now)) {
      actions.push({ type: 'reap', taskId: task.id, owner: task.owner, reason: 'lease-expired' })
    }
  }

  // 2. deadlock — work exists, nothing is claimable, nothing is live
  const live = tasks.filter((task) => task.status === 'claimed' && !isLeaseExpired(task, state.leases, now))
  const claimable = tasks.filter((task) => task.status === 'todo'
    && isReady(task, state.tasks)
    && (task.failures ?? 0) < cfg.maxAttempts)
  const open = tasks.filter((task) => task.status !== 'done' && task.status !== 'failed')
  if (open.length > 0 && claimable.length === 0 && live.length === 0 && stalledTicks >= cfg.deadlockTicks) {
    actions.push({ type: 'deadlock', taskIds: open.map((task) => task.id) })
  }

  // 3. dispatch — respect the concurrency cap and per-scope single-writer rule
  const claimed = tasks.filter((task) => task.status === 'claimed')
  const busyScopes = new Set(claimed.flatMap((task) => task.writeScopes ?? []))
  let free = Math.max(0, cfg.maxConcurrent - runningCount - claimed.length)
  for (const task of claimable.sort(byPriority)) {
    if (free <= 0) break
    const scopes = task.writeScopes ?? []
    if (scopes.some((scope) => busyScopes.has(scope))) continue
    actions.push({ type: 'dispatch', taskId: task.id, writeScopes: scopes })
    for (const scope of scopes) busyScopes.add(scope)
    free -= 1
  }

  // 4. audit — claimed work with no progress beacon
  for (const task of live) {
    const age = now - Date.parse(task.claimedAt ?? new Date(now).toISOString())
    if (age > cfg.leaseTtlMs / 2) actions.push({ type: 'audit', taskId: task.id, ageMs: age })
  }

  const idle = actions.length === 0 && live.length === 0
  return { actions, nextTickMs: idle ? cfg.idleTickMs : cfg.tickMs }
}

function byPriority(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
}

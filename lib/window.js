/**
 * Time-window and budget gates. Pure functions over the ledger — no timers here.
 */

function parts(now, tz) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const out = {}
  for (const part of formatter.formatToParts(new Date(now))) out[part.type] = part.value
  return { day: out.year + '-' + out.month + '-' + out.day, minutes: Number(out.hour) * 60 + Number(out.minute) }
}

export function localMinutes(now, tz) {
  return parts(now, tz).minutes
}

export function localDay(now, tz) {
  return parts(now, tz).day
}

export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(text ?? ''))
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** Off-peak windows may wrap midnight (22:00–06:00). */
export function isOffPeak(now, offPeak) {
  if (!offPeak || offPeak.enabled === false) return true
  const start = parseClock(offPeak.start)
  const end = parseClock(offPeak.end)
  if (start === undefined || end === undefined || start === end) return true
  const current = localMinutes(now, offPeak.tz || 'Asia/Shanghai')
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

/**
 * Off-peak is a display hint only. Scheduling "run at night" belongs to a
 * scheduled trigger that calls crew_pull, not to a gate inside the pull.
 */
export function offPeakHint(now, offPeak) {
  return { active: isOffPeak(now, offPeak), start: offPeak?.start, end: offPeak?.end }
}

/** Tokens burned in the current local day, from finished runs. */
export function tokensToday(records, { now, tz }) {
  const today = localDay(now, tz)
  let sum = 0
  for (const record of records) {
    if (record.type !== 'run.finished' || !Number.isFinite(record.tokens)) continue
    const at = Date.parse(record.at)
    if (!Number.isFinite(at) || localDay(at, tz) !== today) continue
    sum += record.tokens
  }
  return sum
}

export function spendToday(records, { now, tz }) {
  const tokens = tokensToday(records, { now, tz })
  const price = Number(records.pricePerMToken ?? 0)
  return { tokens, cost: (tokens / 1e6) * price }
}

export function budgetExhausted(records, { now, config }) {
  if (!Number.isFinite(config.dailyBudget)) return false
  const price = Number(config.costPerMToken ?? 0)
  if (price <= 0) return false
  const tokens = tokensToday(records, { now, tz: config.offPeak?.tz || 'Asia/Shanghai' })
  return (tokens / 1e6) * price >= config.dailyBudget
}
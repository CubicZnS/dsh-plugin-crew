/**
 * Fold the ledger into the JSON shape both the RPC and the HTML panel render.
 */
export function buildPanelData(records) {
  const tasks = new Map()
  const runs = new Map()
  const inbox = []
  for (const record of records) {
    if (record.type === 'task.created') {
      tasks.set(record.taskId, {
        id: record.taskId, subject: record.subject ?? '', type: record.taskType ?? 'code',
        status: 'todo', attempts: 0, failures: 0, writeScopes: record.writeScopes ?? [],
        createdAt: record.at, runs: [],
      })
      continue
    }
    if (record.type === 'run.started') {
      const run = {
        id: record.runId, taskId: record.taskId, kind: record.kind ?? 'work', status: 'running',
        startedAt: record.at, prompt: record.prompt ?? '', summary: '', artifacts: [],
      }
      runs.set(record.runId, run)
      tasks.get(record.taskId)?.runs.push(run)
      continue
    }
    if (record.type === 'run.reported' || record.type === 'run.finished') {
      const run = runs.get(record.runId)
      if (run) {
        run.status = record.status
        run.summary = record.summary ?? record.error ?? ''
        run.artifacts = record.artifacts ?? []
        run.reportedAt = record.at
        run.tokens = record.tokens
      }
      continue
    }
    if (record.type === 'inbox.opened') {
      inbox.push({ id: record.inboxId, taskId: record.taskId, question: record.question, status: 'open', dueAt: record.dueAt })
      continue
    }
    if (record.type === 'inbox.resolved') {
      const item = inbox.find((entry) => entry.id === record.inboxId)
      if (item) item.status = record.decision
      continue
    }
    const task = tasks.get(record.taskId)
    if (!task) continue
    if (record.type === 'task.claimed') { task.status = 'claimed'; task.attempts += 1; task.owner = record.owner }
    if (record.type === 'task.released') task.status = 'todo'
    if (record.type === 'task.completed') { task.status = 'done'; task.finishedAt = record.at }
    if (record.type === 'task.failed') task.status = 'failed'
    if (record.type === 'task.blocked') { task.status = 'blocked'; task.reason = record.reason }
    if (record.type === 'task.canceled') { task.status = 'canceled'; task.reason = record.cancelReason }
    if (record.type === 'task.review.requested') task.status = 'review'
    if (record.type === 'review.verdict') {
      task.status = record.verdict === 'pass' ? 'done' : 'todo'
      if (record.verdict === 'fail') task.failures += 1
    }
    if (record.type === 'run.reported' && record.status === 'failed' && runs.get(record.runId)?.kind === 'work') task.failures += 1
  }

  const all = [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
  const counts = all.reduce((acc, task) => { acc[task.status] = (acc[task.status] ?? 0) + 1; return acc }, {})
  const openInbox = inbox.filter((item) => item.status === 'open')
  const tokens = [...runs.values()].reduce((sum, run) => sum + (run.tokens ?? 0), 0)
  return {
    generatedAt: new Date().toISOString(),
    tasks: all,
    inbox,
    stats: { tasks: all.length, counts, turns: runs.size, tokens, openInbox: openInbox.length },
  }
}

/**
 * Renders the ledger as a self-contained HTML panel.
 *
 * The point is to show the *conversation* between agents: what the Lead handed
 * to a worker, and what the worker reported back. Both live in the ledger, so the
 * panel needs nothing but the file.
 */
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '')

const STATUS_CLASS = {
  done: 'ok', blocked: 'bad', failed: 'bad', canceled: 'muted',
  review: 'warn', claimed: 'warn', todo: 'muted',
}

function pill(status) {
  return '<span class="pill ' + (STATUS_CLASS[status] ?? 'muted') + '">' + esc(status) + '</span>'
}

function conversation(task, runs) {
  if (runs.length === 0) return '<p class="dim small">还没有派过活。</p>'
  return runs.map((run) => {
    const isReview = run.kind === 'review'
    const who = isReview ? 'reviewer' : 'worker'
    const outbound = run.prompt
      ? '<pre class="msg out">' + esc(run.prompt) + '</pre>'
      : '<p class="dim small">（这一轮没有记录提示词）</p>'
    const reply = run.summary || run.artifacts?.length
      ? '<pre class="msg in">' + esc(run.summary ?? '') + (run.artifacts?.length ? '\n\n产物：' + run.artifacts.join('\n') : '') + '</pre>'
      : '<p class="dim small">（还没有回报）</p>'
    return [
      '<div class="turn">',
      '  <div class="who"><span class="arrow">Lead →' + esc(who) + '</span><span class="meta">' + esc(run.id) + '　' + clock(run.startedAt) + '</span></div>',
      outbound,
      '  <div class="who"><span class="arrow">' + esc(who) + ' → Lead</span><span class="meta">' + (run.status === 'running' ? '等待中' : esc(run.status)) + '　' + clock(run.reportedAt) + '</span></div>',
      reply,
      '</div>',
    ].join('\n')
  }).join('\n')
}

export function renderPanel(records, { title = 'crew 班组面板', ledgerPath = '' } = {}) {
  const data = buildPanelData(records)
  const all = data.tasks
  const { counts, tokens } = data.stats
  const openInbox = data.inbox.filter((item) => item.status === 'open')
  const totalTurns = data.stats.turns

  const cards = all.map((task) => [
    '<section class="task">',
    '  <header>',
    '    <div><span class="id">' + esc(task.id) + '</span> <strong>' + esc(task.subject) + '</strong></div>',
    '    <div class="tags">' + pill(task.status) + '<span class="tag">' + esc(task.type) + '</span>'
      + (task.attempts ? '<span class="tag">尝试 ' + task.attempts + '</span>' : '')
      + (task.failures ? '<span class="tag bad">失败 ' + task.failures + '</span>' : '')
      + (task.reason ? '<span class="tag bad">' + esc(task.reason) + '</span>' : '')
      + '</div>',
    '  </header>',
    (task.writeScopes?.length ? '  <p class="dim small">写域：' + esc(task.writeScopes.join(', ')) + '</p>' : ''),
    '  <div class="thread">',
    conversation(task, task.runs),
    '  </div>',
    '</section>',
  ].join('\n')).join('\n')

  const inboxRows = openInbox.length === 0
    ? '<p class="dim small">没有等你拍板的事。</p>'
    : openInbox.map((item) => '<div class="task"><header><div><span class="id">' + esc(item.id) + '</span> <strong>' + esc(item.question) + '</strong></div><div class="tags"><span class="tag">' + esc(item.taskId) + '</span></div></header></div>').join('\n')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#161a21; --line:#262b35; --fg:#e7e9ef; --dim:#8b93a7; --ok:#3fb950; --bad:#f85149; --warn:#d29922; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 22px 60px; background:var(--bg); color:var(--fg); font:14px/1.65 -apple-system, "PingFang SC", system-ui, sans-serif; }
  h1 { font-size:19px; margin:0 0 2px; } .sub { color:var(--dim); font-size:12px; margin-bottom:22px; }
  .cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:26px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; min-width:110px; }
  .card b { display:block; font-size:20px; font-weight:600; } .card span { color:var(--dim); font-size:12px; }
  section.task { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; }
  section.task header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .id { font-family: ui-monospace, Menlo, monospace; font-size:12px; color:var(--accent); }
  .tags { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .tag { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
  .tag.bad { color:var(--bad); border-color:var(--bad); }
  .pill { font-size:11px; padding:1px 9px; border-radius:999px; border:1px solid var(--line); }
  .pill.ok { color:var(--ok); border-color:var(--ok); } .pill.bad { color:var(--bad); border-color:var(--bad); }
  .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.muted { color:var(--dim); }
  .thread { margin-top:12px; border-left:2px solid var(--line); padding-left:14px; }
  .turn { margin:0 0 16px; } .turn:last-child { margin-bottom:0; }
  .who { display:flex; justify-content:space-between; gap:10px; font-size:12px; color:var(--dim); margin-bottom:4px; }
  .arrow { color:var(--accent); }
  pre.msg { margin:0 0 8px; padding:10px 12px; border-radius:8px; white-space:pre-wrap; word-break:break-word;
            font:12px/1.6 ui-monospace, Menlo, monospace; border:1px solid var(--line); }
  pre.out { background:#12161d; color:#c9d3e3; }
  pre.in { background:#101820; color:#b8e0c0; border-color:#22402c; }
  .dim { color:var(--dim); } .small { font-size:12px; } .bad { color:var(--bad); }
  h2 { font-size:14px; color:var(--dim); font-weight:600; letter-spacing:.05em; margin:26px 0 10px; }
</style></head>
<body>
<h1>${esc(title)}</h1>
<div class="sub">${esc(ledgerPath)} · 记录 ${records.length} 条 · ${all.length} 个任务 / ${totalTurns} 轮对话 · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>

<div class="cards">
  <div class="card"><b>${all.length}</b><span>任务</span></div>
  <div class="card"><b class="ok">${counts.done ?? 0}</b><span>完成</span></div>
  <div class="card"><b class="${counts.blocked ? 'bad' : ''}">${counts.blocked ?? 0}</b><span>阻塞</span></div>
  <div class="card"><b>${counts.review ?? 0}</b><span>待评审</span></div>
  <div class="card"><b>${openInbox.length}</b><span>待拍板</span></div>
  <div class="card"><b>${tokens}</b><span>tokens</span></div>
</div>

<h2>任务与对话</h2>
${cards || '<p class="dim">账本还是空的。先 crew_task_add 加一条。</p>'}

<h2>等你拍板</h2>
${inboxRows}
</body></html>`
}
#!/usr/bin/env node
/**
 * P1 读数面板：把账本渲染成一张自包含 HTML（无外链、无脚本），双击就能看。
 * 侧边栏版面板留到 P2（那时才有 roster 可画）。
 */
import { parseArgs } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { fold } from '../lib/fold.js'
import { checkInvariants } from '../lib/audit.js'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string', default: './.crew/ledger.jsonl' },
    out: { type: 'string', default: './.crew/report.html' },
  },
})

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-')

const records = await new Ledger(resolve(values.ledger)).records()
const state = fold(records)
const invariants = checkInvariants(records)

const tasks = [...state.tasks.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
const runs = [...state.runs.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
const inbox = [...state.inbox.values()]
const countBy = (items, pick) => items.reduce((acc, item) => { const key = pick(item); acc[key] = (acc[key] ?? 0) + 1; return acc }, {})

const bad = (value) => ['blocked', 'failed', 'interrupted', 'timed_out'].includes(value)

const rows = tasks.map((task) => `
    <tr class="${bad(task.status) ? 'bad' : task.status === 'done' ? 'good' : ''}">
      <td class="mono">${esc(task.id)}</td>
      <td>${esc(task.subject)}</td>
      <td><span class="pill ${esc(task.status)}">${esc(task.status)}</span></td>
      <td class="mono">${esc(task.owner ?? '-')}</td>
      <td class="num">${task.attempts ?? 0} / ${task.failures ?? 0}</td>
      <td class="mono dim">${esc((task.writeScopes ?? []).join(' ')) || '-'}</td>
      <td class="dim">${fmtTime(task.claimedAt ?? task.createdAt)}</td>
    </tr>`).join('')

const inboxRows = inbox.length === 0
  ? '<p class="dim">没有需要人处理的事。</p>'
  : inbox.map((item) => `
    <tr class="${item.status === 'open' ? 'bad' : ''}">
      <td class="mono">${esc(item.id)}</td>
      <td>${esc(item.question)}</td>
      <td>${esc(item.status)}</td>
      <td class="dim">${fmtTime(item.dueAt ? new Date(item.dueAt).toISOString() : undefined)}</td>
    </tr>`).join('')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>crew 账本</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --line:#272b35; --fg:#e6e8ee; --dim:#8b93a7; --good:#3fb950; --bad:#f85149; --warn:#d29922; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6ec; --fg:#1b1f27; --dim:#6b7280; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 10px; color:var(--dim); font-weight:600; letter-spacing:.04em; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:24px; }
  .cards { display:flex; gap:12px; flex-wrap:wrap; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 18px; min-width:120px; }
  .card b { display:block; font-size:22px; font-weight:600; } .card span { color:var(--dim); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th { text-align:left; font-size:12px; color:var(--dim); font-weight:500; padding:10px 12px; border-bottom:1px solid var(--line); }
  td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  tr.bad td:first-child { box-shadow: inset 3px 0 0 var(--bad); } tr.good td:first-child { box-shadow: inset 3px 0 0 var(--good); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12px; } .dim { color:var(--dim); } .num { text-align:right; font-variant-numeric: tabular-nums; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); }
  .pill.done { color:var(--good); border-color:var(--good); } .pill.blocked, .pill.failed { color:var(--bad); border-color:var(--bad); }
  .pill.claimed { color:var(--warn); border-color:var(--warn); }
  .ok { color:var(--good); } .fail { color:var(--bad); }
</style></head><body>
<h1>crew 账本</h1>
<div class="sub">${esc(values.ledger)} · 记录 ${records.length} 条 · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>

<div class="cards">
  <div class="card"><b>${tasks.length}</b><span>任务</span></div>
  <div class="card"><b class="ok">${countBy(tasks, (t) => t.status).done ?? 0}</b><span>完成</span></div>
  <div class="card"><b class="${bad('blocked') && (countBy(tasks, (t) => t.status).blocked ?? 0) > 0 ? 'fail' : ''}">${countBy(tasks, (t) => t.status).blocked ?? 0}</b><span>阻塞</span></div>
  <div class="card"><b>${state.leases.size}</b><span>有效租约</span></div>
  <div class="card"><b class="${invariants.ok ? 'ok' : 'fail'}">${invariants.ok ? 'OK' : 'BAD'}</b><span>不变量</span></div>
</div>

<h2>任务</h2>
<table><thead><tr><th>ID</th><th>标题</th><th>状态</th><th>owner</th><th class="num">尝试/失败</th><th>写域</th><th>时间</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="dim">账本为空。</td></tr>'}</tbody></table>

<h2>收件箱</h2>
<table><thead><tr><th>ID</th><th>问题</th><th>状态</th><th>到期</th></tr></thead><tbody>${inboxRows}</tbody></table>

<h2>运行</h2>
<p class="dim">${Object.entries(countBy(runs, (r) => r.status)).map(([k, v]) => k + ' ' + v).join(' · ') || '没有运行记录'}</p>
${invariants.issues.length ? '<p class="fail">不变量问题：' + invariants.issues.map(esc).join('；') + '</p>' : ''}
</body></html>
`

await mkdir(dirname(resolve(values.out)), { recursive: true })
await writeFile(resolve(values.out), html, 'utf8')
console.log('report: ' + resolve(values.out) + ' (' + tasks.length + ' tasks, ' + runs.length + ' runs)')

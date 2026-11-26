#!/usr/bin/env node
/**
 * Standalone tick runner. Used for the P1 acceptance test (kill -9 and restart)
 * and for eyeballing a simulated workday without booting the harness.
 */
import { parseArgs } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Ledger } from '../lib/ledger.js'
import { fold } from '../lib/fold.js'
import { Scheduler } from '../lib/scheduler.js'
import { StubExecutor } from '../lib/executor.js'
import { checkInvariants } from '../lib/audit.js'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string', default: './.crew/ledger.jsonl' },
    tasks: { type: 'string', default: '0' },
    work: { type: 'string', default: '800' },
    tick: { type: 'string', default: '200' },
    ticks: { type: 'string', default: '0' },
    summary: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
})

const file = resolve(values.ledger)
const ledger = new Ledger(file)
const log = values.quiet ? () => {} : (message, extra) => {
  console.log('[crew] ' + message + (extra ? ' ' + JSON.stringify(extra) : ''))
}

async function seed(count) {
  const records = await ledger.records()
  if (records.some((record) => record.type === 'task.created') || count <= 0) return
  const scopes = ['src/', 'docs/', 'tests/']
  for (let index = 1; index <= count; index += 1) {
    await ledger.append({
      type: 'task.created',
      taskId: 'task-' + index,
      subject: 'simulated task ' + index,
      writeScopes: [scopes[(index - 1) % scopes.length]],
    })
  }
  console.log('[crew] seeded ' + count + ' task(s) into ' + file)
}

async function summary() {
  const records = await ledger.records()
  const state = fold(records)
  const by = (map, pick) => [...map.values()].reduce((acc, item) => {
    const key = pick(item)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const tasks = by(state.tasks, (task) => task.status)
  const runs = by(state.runs, (run) => run.status)
  const openInbox = [...state.inbox.values()].filter((item) => item.status === 'open').length
  const invariants = checkInvariants(records)

  const fmt = (object) => Object.entries(object).sort().map(([key, value]) => key + '=' + value).join(' ') || 'none'
  console.log('summary tasks: ' + fmt(tasks))
  console.log('summary runs: ' + fmt(runs))
  console.log('summary leases: ' + state.leases.size + ' open-inbox=' + openInbox)
  console.log('invariants: ' + (invariants.ok ? 'ok' : 'FAILED ' + JSON.stringify(invariants.issues)))
  return { tasks, runs, openInbox, invariants }
}

async function main() {
  await mkdir(dirname(file), { recursive: true })
  await seed(Number(values.tasks))

  const executor = new StubExecutor({ durationMs: Number(values.work) })
  const scheduler = new Scheduler({ ledger, executor, config: { tickMs: Number(values.tick) }, log })

  const recovered = await scheduler.recover()
  if (recovered.length > 0) console.log('[crew] recovered ' + recovered.length + ' interrupted run(s): ' + recovered.join(','))
  const limit = Number(values.ticks)
  if (limit > 0) {
    for (let index = 0; index < limit; index += 1) {
      const result = await scheduler.tick()
      if (result.actions.length > 0 && !values.quiet) {
        console.log('[crew] tick ' + index + ': ' + result.actions.map((action) => action.type + (action.taskId ? ':' + action.taskId : '')).join(', '))
      }
      await scheduler.whenIdle()
      if (index < limit - 1) await new Promise((done) => setTimeout(done, Number(values.tick)))
    }
  } else {
    const stop = () => { scheduler.stop() }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await scheduler.start()
  }

  scheduler.stop()
  const result = await summary()
  if (!result.invariants.ok) process.exitCode = 1
}

await main()

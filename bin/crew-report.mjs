#!/usr/bin/env node
/**
 * Render the ledger into a portable HTML panel and optionally open or serve it.
 *
 *   node bin/crew-report.mjs                      # 渲染到 ~/.dsh/crew/panel.html
 *   node bin/crew-report.mjs --open               # 渲染后打开浏览器
 *   node bin/crew-report.mjs --serve 7788         # 起一个本地页面，手机也能看
 */
import { parseArgs } from 'node:util'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Ledger } from '../lib/ledger.js'
import { renderPanel } from '../lib/panel.js'

const { values } = parseArgs({
  options: {
    ledger: { type: 'string', default: join(homedir(), '.dsh/crew/ledger.jsonl') },
    out: { type: 'string', default: join(homedir(), '.dsh/crew/panel.html') },
    open: { type: 'boolean', default: false },
    serve: { type: 'string', default: undefined },
    title: { type: 'string', default: 'crew 班组面板' },
  },
})

const ledgerPath = resolve(values.ledger)

async function render() {
  const records = await new Ledger(ledgerPath).records()
  const html = renderPanel(records, { title: values.title, ledgerPath })
  await mkdir(dirname(resolve(values.out)), { recursive: true })
  await writeFile(resolve(values.out), html, 'utf8')
  return { html, records }
}

if (values.serve) {
  const port = Number(values.serve) || 7788
  createServer(async (req, res) => {
    try {
      const records = await new Ledger(ledgerPath).records()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPanel(records, { title: values.title, ledgerPath }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('render failed: ' + error)
    }
  }).listen(port, '127.0.0.1', () => {
    console.log('panel: http://127.0.0.1:' + port + '/')
    console.log('（同一个 Wi-Fi 下，把 127.0.0.1 换成这台机器的局域网 IP，手机就能看）')
  })
} else {
  const { records } = await render()
  console.log('panel: ' + resolve(values.out) + '　(' + records.length + ' 条记录)')
  if (values.open) spawn('open', [resolve(values.out)], { stdio: 'ignore', detached: true }).unref()
}

/**
 * Append-only JSONL ledger. One record per line; never rewritten.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const RECORD_VERSION = 1

export class Ledger {
  constructor(file) {
    this.file = file
  }

  async append(record) {
    const line = JSON.stringify({
      v: RECORD_VERSION,
      at: new Date().toISOString(),
      ...record,
    })
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, line + '\n', 'utf8')
    return record
  }

  async records() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        out.push({ type: 'corrupt', raw: line.slice(0, 200) })
      }
    }
    return out
  }
}

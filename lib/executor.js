/**
 * Executor seam. P1 ships only the stub; P2 plugs the real Agent Teams worker in
 * behind the same interface so the scheduler never learns what a "run" really is.
 */
export class Executor {
  /** @returns {Promise<{status: 'succeeded'|'failed'|'cancelled', tokens?: number, error?: string}>} */
  async run(_task, _context) {
    throw new Error('Executor.run is not implemented')
  }
}

export class StubExecutor extends Executor {
  constructor({ durationMs = 50, outcome = 'succeeded', tokens = 128 } = {}) {
    super()
    this.durationMs = durationMs
    this.outcome = outcome
    this.tokens = tokens
  }

  async run(_task, { signal } = {}) {
    await new Promise((resolve, reject) => {
      // Deliberately not unref'd: a live run must keep the process alive.
      const timer = setTimeout(resolve, this.durationMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })
    return { status: this.outcome, tokens: this.tokens }
  }
}

/** Test/daemon helper: hand-resolved runs, no timers. */
export class ControlledExecutor extends Executor {
  constructor() {
    super()
    this.pending = []
  }

  run(task) {
    return new Promise((resolve) => { this.pending.push({ task, resolve }) })
  }

  async finish(index, result) {
    const item = this.pending.splice(index, 1)[0]
    if (!item) throw new Error('no pending run at index ' + index)
    item.resolve(result)
    await Promise.resolve()
  }
}

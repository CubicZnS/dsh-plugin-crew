/**
 * The real executor: dispatch a handoff into the Team, wait for the worker's
 * crew_report record, then (for kinds that need it) run an independent blind review.
 *
 * The review loop lives here rather than in the scheduler so the scheduler stays
 * unaware of agents, models and rubrics.
 */
import { Executor } from './executor.js'
import { kindOf, requiresReview, rubricFor } from './kinds.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function workPrompt({ task, runId, attempt }) {
  const kind = kindOf(task.type)
  return [
    '[crew] 任务 ' + task.id + '　第 ' + attempt + ' 次执行（run ' + runId + '）',
    '目标：' + (task.subject ?? ''),
    task.description ? '背景：' + task.description : undefined,
    '写域：' + ((task.writeScopes ?? []).join(', ') || '无（只读）') + '　只动这些路径，别顺手改别的。',
    '验收标准：',
    task.acceptance ? task.acceptance : kind.rubric.map((line) => '- ' + line).join('\n'),
    '完成后**必须**调用 crew_report：run_id="' + runId + '"，status 取 succeeded/failed/blocked，',
    '并给出 summary（做了什么）、artifacts（产物路径）、needs（需要人或评审做什么）。',
    '不要自己改账本，不要给自己派活。',
  ].filter(Boolean).join('\n')
}

export function reviewPrompt({ task, reviewId }) {
  return [
    '[crew] 盲审 ' + reviewId + '：评审任务 ' + task.id + ' 的产物',
    '目标：' + (task.subject ?? ''),
    '验收标准：',
    rubricFor(task.type),
    '你看不到执行者的对话，只看产物。逐条判断，任何一条不满足就驳回。',
    '调用 crew_report：run_id="' + reviewId + '"，status=succeeded 表示通过，failed 表示驳回，',
    'summary 里写清哪一条不满足、具体缺什么。',
  ].join('\n')
}

export class TeamExecutor extends Executor {
  constructor({ ledger, team, workerName = 'worker', reviewerName = 'reviewer', clock = () => Date.now(), pollMs = 1500, timeoutMs = 30 * 60 * 1000, log = () => {} }) {
    super()
    this.timeoutMs = timeoutMs
    this.ledger = ledger
    this.team = team
    this.workerName = workerName
    this.reviewerName = reviewerName
    this.clock = clock
    this.pollMs = pollMs
    this.log = log
  }

  /** The scheduler skips a tick entirely when no live Team can accept work. */
  isReady() {
    return this.team.available !== false
  }

  async run(task, { signal, runId } = {}) {
    await this.#ensure()
    // Permission tier hangs off the task kind, not the agent.
    this.team.setPermission?.(this.workerName, kindOf(task.type).permissionPreset)

    await this.team.dispatch(this.workerName, workPrompt({ task, runId, attempt: (task.failures ?? 0) + 1 }))
    const work = await this.#awaitReport(runId, signal)
    if (work.status !== 'succeeded') return work

    if (!requiresReview(task.type)) {
      return { status: 'succeeded', tokens: work.tokens, summary: work.summary }
    }

    const reviewId = runId + '-r'
    await this.team.dispatch(this.reviewerName, reviewPrompt({ task, reviewId }))
    const review = await this.#awaitReport(reviewId, signal)
    await this.ledger.append({
      type: 'review.verdict',
      reviewId,
      runId,
      taskId: task.id,
      verdict: review.status === 'succeeded' ? 'pass' : 'fail',
      notes: review.summary,
    })
    if (review.status === 'succeeded') {
      return { status: 'succeeded', tokens: (work.tokens ?? 0) + (review.tokens ?? 0), summary: work.summary }
    }
    return {
      status: 'failed',
      error: 'review-rejected: ' + String(review.summary ?? '').slice(0, 400),
      tokens: (work.tokens ?? 0) + (review.tokens ?? 0),
    }
  }

  async #ensure() {
    await this.team.ensureWorker(this.workerName, '执行任务并把结果写回账本', '你是 crew 的执行工。收到 handoff 就干活，结束必须调用 crew_report 回报。')
    await this.team.ensureWorker(this.reviewerName, '盲审产物', '你是 crew 的盲审员。只看产物和验收标准，逐条判断，必须调用 crew_report 给结论。')
  }

  /** Poll the ledger for the report; the report is the only completion signal. */
  async #awaitReport(runId, signal) {
    const deadline = this.clock() + (this.timeoutMs ?? 30 * 60 * 1000)
    while (!signal?.aborted) {
      const records = await this.ledger.records()
      for (const record of records) {
        if (record.type !== 'run.reported' || record.runId !== runId) continue
        return {
          status: record.status === 'succeeded' ? 'succeeded' : record.status === 'blocked' ? 'failed' : 'failed',
          tokens: record.tokens,
          summary: record.summary,
          error: record.status === 'succeeded' ? undefined : String(record.summary ?? 'reported ' + record.status),
        }
      }
      if (this.clock() >= deadline) return { status: 'timed_out', error: 'no crew_report within timeout' }
      await sleep(this.pollMs)
    }
    return { status: 'cancelled', error: 'cancelled' }
  }
}

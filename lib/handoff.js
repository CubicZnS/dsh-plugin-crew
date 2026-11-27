/**
 * Prompt builders for the pull model: the plugin hands the Lead session a
 * self-contained job, the Lead forwards it to a subagent, the subagent reports
 * back through crew_report.
 */
import { kindOf, rubricFor, requiresReview } from './kinds.js'

export function workJobPrompt({ task, runId }) {
  const kind = kindOf(task.type)
  const lines = [
    '[crew] 任务 ' + task.id + '（run ' + runId + '）',
    '目标：' + (task.subject ?? ''),
    task.description ? '背景：' + task.description : undefined,
    '写域：' + ((task.writeScopes ?? []).join(', ') || '无（只读）') + '。只动这些路径。',
    '验收标准：',
    task.acceptance ? task.acceptance : kind.rubric.map((line) => '- ' + line).join('\n'),
    '',
    '干完之后**必须**调用 crew_report：',
    '  run_id="' + runId + '"',
    '  status="succeeded" | "failed" | "blocked"',
    '  headline=一句话说清结果（不超过 40 字，给面板显示用，不要写文件路径）',
    '  summary=再做两三句说明：做了什么 / 为什么失败',
    '  artifacts=[产物路径]',
    '不调用 crew_report 的话，这轮会被判超时。',
  ]
  return lines.filter((line) => line !== undefined).join('\n')
}

export function reviewJobPrompt({ task, runId, artifacts }) {
  return [
    '[crew] 盲审 ' + task.id + '（run ' + runId + '）',
    '目标：' + (task.subject ?? ''),
    '产物：' + ((artifacts ?? task.artifacts ?? []).join(', ') || '见工作区'),
    '验收标准：',
    rubricFor(task.type),
    '',
    '你看不到执行者的对话，只看产物。任何一条不满足就驳回。',
    '调用 crew_report：run_id="' + runId + '"，status="succeeded" 表示通过，"failed" 表示驳回。',
    'headline=一句话结论（如「通过」「驳回：缺测试」），summary 里写清哪一条不满足。',
  ].join('\n')
}

/** One human-readable line for the Lead to show the user. */
export function describeJob(job) {
  return (job.kind === 'review' ? '评审 ' : '执行 ') + job.taskId + '　' + (job.subject ?? '') + '　run=' + job.runId
}

export { requiresReview }

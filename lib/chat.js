/**
 * Chat projection. Every coordination event already in the ledger becomes a
 * message from someone to someone, so the panel reads like a group chat side by
 * side with the runs that produced it.
 *
 * Nothing here is stored twice: messages are derived from the durable records,
 * plus any explicit message.sent a participant writes with crew_say.
 */
export const PARTICIPANT = {
  user: { id: 'user', name: '你', kind: 'human' },
  lead: { id: 'lead', name: 'Lead', kind: 'lead' },
  worker: { id: 'worker', name: 'worker', kind: 'agent' },
  reviewer: { id: 'reviewer', name: 'reviewer', kind: 'agent' },
  system: { id: 'system', name: '系统', kind: 'system' },
}

export function mentionsIn(text) {
  return [...String(text ?? '').matchAll(/@([\w\u4e00-\u9fa5-]+)/gu)].map((match) => match[1])
}

function oneLine(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/**
 * @param {object[]} records ledger records, oldest first
 * @returns {object[]} messages, oldest first
 */
export function deriveMessages(records) {
  const subjects = new Map()
  const messages = []
  let seq = 0
  const push = (message) => {
    seq += 1
    messages.push({
      id: message.id ?? 'msg-' + seq,
      at: message.at,
      from: message.from,
      to: message.to ?? [],
      text: message.text ?? '',
      taskId: message.taskId,
      runId: message.runId,
      kind: message.kind ?? 'text',
      mentions: mentionsIn(message.text),
    })
  }

  for (const record of records) {
    switch (record.type) {
      case 'task.created':
        subjects.set(record.taskId, record.subject)
        push({
          at: record.at, from: 'user', to: ['lead'], kind: 'task',
          taskId: record.taskId,
          text: '加了个任务：' + (record.subject ?? '') + (record.acceptance ? '（验收：' + oneLine(record.acceptance, 50) + '）' : ''),
        })
        break
      case 'run.started':
        push({
          at: record.at, from: 'lead', to: [record.kind === 'review' ? 'reviewer' : 'worker'], kind: 'handoff',
          taskId: record.taskId, runId: record.runId,
          text: (record.kind === 'review' ? '请盲审 @reviewer：' : '派活 @worker：')
            + (subjects.get(record.taskId) ?? record.taskId),
        })
        break
      case 'run.reported':
        push({
          at: record.at,
          from: record.runId?.endsWith('-r') ? 'reviewer' : 'worker',
          to: ['lead'], kind: 'report',
          taskId: record.taskId, runId: record.runId,
          text: record.headline || oneLine(record.summary, 70)
            || (record.status === 'succeeded' ? '完成' : '失败'),
        })
        break
      case 'review.verdict':
        push({
          at: record.at, from: 'reviewer', to: ['lead'], kind: 'verdict',
          taskId: record.taskId,
          text: record.verdict === 'pass' ? '判决：通过' : '判决：驳回——' + oneLine(record.notes, 60),
        })
        break
      case 'task.blocked':
        push({
          at: record.at, from: 'system', to: ['user'], kind: 'system',
          taskId: record.taskId,
          text: '任务 ' + record.taskId + ' 卡住了（' + record.reason + '），等 @你 拍板。',
        })
        break
      case 'task.canceled':
        push({ at: record.at, from: 'system', to: [], kind: 'system', taskId: record.taskId, text: '任务 ' + record.taskId + ' 已取消' + (record.reason ? '：' + oneLine(record.reason, 40) : '') })
        break
      case 'inbox.opened':
        push({ at: record.at, from: 'system', to: ['user'], kind: 'inbox', taskId: record.taskId, text: oneLine(record.question, 90) })
        break
      case 'inbox.resolved':
        push({ at: record.at, from: 'user', to: ['lead'], kind: 'inbox', text: record.decision === 'approved' ? '批准了' : '驳回了' })
        break
      case 'message.sent':
        push({
          id: record.messageId, at: record.at, from: record.from, to: record.to ?? [],
          text: record.text, taskId: record.taskId, runId: record.runId, kind: 'text',
        })
        break
      default:
        break
    }
  }
  return messages
}

/** Render text with @mentions wrapped in a span; returns safe HTML. */
export function renderMentions(text) {
  const escaped = String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]))
  return escaped.replace(/@([\w\u4e00-\u9fa5-]+)/gu, '<span class="mention">@$1</span>')
}

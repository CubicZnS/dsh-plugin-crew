/**
 * Task-kind registry. Permission tier, write scopes, rubric and deliverable all
 * hang off the kind — never off the agent — so one worker can be read-only on a
 * research task and write-capable on a code task.
 */
export const KINDS = {
  code: {
    label: '代码/工程',
    permissionPreset: 'workspace-write',
    writeScopes: ['src/'],
    review: true,
    deliverable: 'commit',
    rubric: [
      '改动范围与任务一致，没有顺手改无关文件',
      '测试或构建通过（失败必须附原始输出）',
      '没有遗留调试代码、临时文件、被注释掉的旧实现',
    ],
  },
  research: {
    label: '文献/研究',
    permissionPreset: 'read-only',
    writeScopes: ['docs/'],
    review: true,
    deliverable: 'note',
    rubric: [
      '每条结论都能追溯到具体来源（标题/DOI/链接）',
      '没有来源不明的判断，没有把摘要当全文',
      '产物是可读的笔记，不是链接堆',
    ],
  },
  content: {
    label: '内容运营',
    permissionPreset: 'workspace-write',
    writeScopes: ['content/'],
    review: true,
    deliverable: 'draft',
    rubric: [
      '符合给定受众与语气，没有自造事实',
      '结构与标题层级清楚，首段能独立说明主题',
    ],
  },
  monitor: {
    label: '数据/监控',
    permissionPreset: 'read-only',
    writeScopes: ['data/'],
    review: false,
    deliverable: 'report',
    rubric: [
      '数据窗口与采样口径写清楚',
      '异常有阈值依据，不是凭感觉点名',
    ],
  },
}

export const DEFAULT_KIND = 'code'

export function kindOf(type) {
  return KINDS[type] ?? KINDS[DEFAULT_KIND]
}

/** Rubric as a plain checklist the reviewer can score line by line. */
export function rubricFor(type) {
  return kindOf(type).rubric.map((line, index) => (index + 1) + '. ' + line).join('\n')
}

export function requiresReview(type) {
  return kindOf(type).review === true
}

export function listKinds() {
  return Object.entries(KINDS).map(([id, kind]) => ({ id, label: kind.label, permission: kind.permissionPreset, review: kind.review }))
}

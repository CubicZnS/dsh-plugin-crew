/**
 * Thin adapter over the experimental Agent Teams service — the only file that
 * knows it exists. Everything is feature-detected so the plugin still loads on a
 * host without the Team packages.
 */
export function teamAvailable(ctx) {
  return Boolean(ctx && ctx.agents && ctx.agentTeams && typeof ctx.agentTeams.sendMessage === 'function')
}

/** The implicit Lead is the root session agent; discover it from the live registry. */
export function discoverLead(ctx) {
  if (!teamAvailable(ctx)) return undefined
  for (const agent of ctx.agents.list()) {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership && membership.role === 'lead') return agent
  }
  return undefined
}

export class TeamAdapter {
  constructor({ ctx, log = () => {} }) {
    this.ctx = ctx
    this.log = log
    this.lead = discoverLead(ctx)
  }

  get available() {
    return this.lead !== undefined
  }

  members() {
    if (!this.lead) return []
    return this.ctx.agentTeams.listMembers(this.lead).map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
    }))
  }

  has(name) {
    return this.members().some((member) => member.name === name)
  }

  /** Spawn a teammate once; names are permanent in the Team service, so re-use it. */
  async ensureWorker(name, description, prompt) {
    if (!this.lead) throw new Error('team-unavailable')
    if (this.has(name)) return name
    await this.ctx.agentTeams.spawnTeammate(this.lead, {
      name,
      description,
      prompt: [{ type: 'text', text: prompt }],
      context: 'fresh',
      provider: 'spawn',
      signal: new AbortController().signal,
    })
    return name
  }

  /** Deliver one handoff. Durable mailbox: queued if the target is inactive. */
  async dispatch(name, text) {
    if (!this.lead) throw new Error('team-unavailable')
    const result = await this.ctx.agentTeams.sendMessage(this.lead, {
      target: name,
      content: [{ type: 'text', text }],
      signal: new AbortController().signal,
    })
    return result.status
  }

  /**
   * Apply a task-kind permission tier to a teammate before dispatch. Best effort:
   * an inactive teammate has no live session, and the preset is re-applied next time.
   */
  setPermission(name, presetId) {
    if (!this.lead || !presetId || !this.ctx.permissionPresets) return false
    const member = this.ctx.agentTeams.listMembers(this.lead).find((item) => item.name === name)
    if (!member) return false
    const agent = this.ctx.agents.get(member.id)
    if (!agent) return false
    try {
      this.ctx.permissionPresets.set(agent.session, presetId)
      return true
    } catch (error) {
      this.log('permission preset ' + presetId + ' not applied to ' + name + ': ' + error)
      return false
    }
  }

  interrupt(name) {
    if (!this.lead) return undefined
    return this.ctx.agentTeams.interrupt(this.lead, name)
  }
}

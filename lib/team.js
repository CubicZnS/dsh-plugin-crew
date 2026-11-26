/**
 * Thin adapter over the experimental Agent Teams service — the only file that
 * knows it exists.
 *
 * Services are resolved through ctx.get() instead of ctx.<name>: Cordis throws on
 * touching an undeclared service, and this plugin must still load on a host
 * without the Team bundle (it degrades to tools-only).
 */
export function serviceOf(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

export function teamAvailable(ctx) {
  const agents = serviceOf(ctx, 'agents')
  const teams = serviceOf(ctx, 'agentTeams')
  return Boolean(
    agents && typeof agents.list === 'function' && typeof agents.get === 'function'
    && teams && typeof teams.tryMembership === 'function' && typeof teams.sendMessage === 'function',
  )
}

/** Shape report for diagnostics: a service may exist but not be the one we expect. */
export function describeServices(ctx) {
  const probe = (name) => {
    const value = serviceOf(ctx, name)
    if (value === undefined || value === null) return 'missing'
    if (typeof value !== 'object' && typeof value !== 'function') return typeof value
    const methods = ['list', 'get', 'tryMembership', 'sendMessage', 'spawnTeammate', 'set']
      .filter((key) => typeof value[key] === 'function')
    return (value.constructor?.name || 'object') + '{' + methods.join(',') + '}'
  }
  return { agents: probe('agents'), agentTeams: probe('agentTeams'), permissionPresets: probe('permissionPresets') }
}

function sessionCwd(agent) {
  return agent?.session?.header?.cwd ?? agent?.options?.cwd
}

/**
 * The implicit Lead is a root session agent. With several sessions open we need a
 * tie-break: the configured home workspace wins, otherwise the newest root.
 */
export function discoverLead(ctx, { homeWorkspace } = {}) {
  if (!teamAvailable(ctx)) return undefined
  const agents = serviceOf(ctx, 'agents')
  const teams = serviceOf(ctx, 'agentTeams')
  const leads = []
  try {
    for (const agent of agents.list()) {
      const membership = teams.tryMembership(agent)
      if (membership && membership.role === 'lead') leads.push(agent)
    }
  } catch (error) {
    return undefined
  }
  if (leads.length === 0) return undefined
  if (homeWorkspace) {
    const inHome = leads.find((agent) => {
      const cwd = sessionCwd(agent)
      return typeof cwd === 'string' && (cwd === homeWorkspace || cwd.startsWith(homeWorkspace + '/'))
    })
    if (inHome) return inHome
  }
  return leads[leads.length - 1]
}

export class TeamAdapter {
  constructor({ ctx, log = () => {}, homeWorkspace }) {
    this.ctx = ctx
    this.log = log
    this.homeWorkspace = homeWorkspace
    this.agents = serviceOf(ctx, 'agents')
    this.teams = serviceOf(ctx, 'agentTeams')
    this.permissions = serviceOf(ctx, 'permissionPresets')
  }

  /** Resolved on every use: teammates and sessions appear and disappear at runtime. */
  get lead() {
    return discoverLead(this.ctx, { homeWorkspace: this.homeWorkspace })
  }

  get available() {
    return this.lead !== undefined
  }

  members() {
    if (!this.lead) return []
    return this.teams.listMembers(this.lead).map((member) => ({
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
    await this.teams.spawnTeammate(this.lead, {
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
    const result = await this.teams.sendMessage(this.lead, {
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
    if (!this.lead || !presetId || !this.permissions) return false
    const member = this.teams.listMembers(this.lead).find((item) => item.name === name)
    if (!member) return false
    const agent = this.agents.get(member.id)
    if (!agent) return false
    try {
      this.permissions.set(agent.session, presetId)
      return true
    } catch (error) {
      this.log('permission preset ' + presetId + ' not applied to ' + name + ': ' + error)
      return false
    }
  }

  interrupt(name) {
    if (!this.lead) return undefined
    return this.teams.interrupt(this.lead, name)
  }
}

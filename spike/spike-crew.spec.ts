import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-crew-spike-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead }
}

function spawn(ctx: Context, lead: Agent, name: string, prompt: string) {
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: name + ' responsibility',
    prompt: content(prompt),
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

/** The plugin-side discovery path: no tool call, no model, just live registry + membership. */
function discoverLead(ctx: Context): Agent | undefined {
  return ctx.agents.list().find((agent) => ctx.agentTeams.tryMembership(agent)?.role === 'lead')
}

describe('S1 - scheduler code can drive the board without a tool call', () => {
  it('discovers the lead from ctx.agents.list() and reassigns a task by name', async () => {
    const { ctx, lead } = await setup([textResponse('idle')])
    await spawn(ctx, lead, 'worker', 'worker initial')

    const scheduler = discoverLead(ctx)
    expect(scheduler).toBe(lead)
    expect(ctx.agentTeams.membership(scheduler!).name).toBe('lead')

    const task = await ctx.agentTeams.createTask(scheduler!, {
      subject: 'write the plan',
      description: 'draft and file it',
      writeScopes: ['docs/'],
    })
    const assigned = await ctx.agentTeams.updateTask(scheduler!, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'worker',
    })
    expect(assigned.status).toBe('in_progress')
    expect(assigned.ownerName).toBe('worker')

    const doomed = await ctx.agentTeams.createTask(scheduler!, {
      subject: 'blocked work',
      description: 'waits for the first task',
      blockedBy: [task.id],
    })
    expect(doomed.readiness ?? 'blocked').not.toBe('ready')
    await expect(ctx.agentTeams.updateTask(scheduler!, {
      taskId: doomed.id,
      expectedRevision: doomed.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
  })
})

describe('S2 - cold resume after an inactive teammate is addressed', () => {
  it('wakes an inactive teammate with the sender attribution intact', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'night-shift', 'night shift initial')
    const worker = await vi.waitFor(() => {
      const agent = ctx.agents.get(started.member.id)
      expect(agent?.status).toBe('running')
      return agent!
    }, { timeout: 5_000 })

    ctx.agentTeams.interrupt(lead, 'night-shift')
    await waitNoAgent(ctx, worker.id)
    expect(ctx.agentTeams.listMembers(lead).find((m) => m.name === 'night-shift')?.status).toBe('inactive')

    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'night-shift',
      content: content('pick up task-1 now'),
      signal: SIGNAL,
    })
    expect(sent.status).toBe('accepted')

    const revived = await vi.waitFor(() => {
      const agent = ctx.agents.get(started.member.id)
      expect(agent).toBeDefined()
      return agent!
    }, { timeout: 5_000 })
    expect(revived.status).not.toBe('inactive')
    expect(ctx.agentTeams.listMembers(lead).find((m) => m.name === 'night-shift')?.status).not.toBe('inactive')
    const delivered = await vi.waitFor(() => {
      const peer = revived.session.snapshotEvents().filter((event) => event.type === 'user/message'
        && event.data.source.kind === 'team-message')
      expect(peer).toHaveLength(1)
      return peer
    }, { timeout: 5_000 })
    expect(delivered[0].type === 'user/message' && delivered[0].data.content.at(-1)).toMatchObject({
      type: 'text', text: 'pick up task-1 now',
    })
  })
})

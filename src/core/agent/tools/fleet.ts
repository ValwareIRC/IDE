// Helpers on any of Prism's models, and fleets: saved teams of them, run by name. Prism's own
// agent already has spawn_agent; these bring the same to a Claude conversation (Prism runs the
// helpers with its own agent, on GLM or whatever model each is given), and let either kind of
// lead run a fleet the user designed in Settings.
import type { Fleet, ModelRef } from '@shared/types'
import type { TeamSpec } from '../background'
import { bool, err, str, type AgentTool, type ToolContext } from './types'

/** What runs the helpers: Prism's agent, on the session's behalf. */
export interface HelperKit {
  spawn(task: string, opts: { name?: string; model?: string; readOnly?: boolean; background?: boolean }): Promise<{ ok: boolean; summary: string }>
  team(spec: TeamSpec, background: boolean): Promise<{ ok: boolean; summary: string }>
}

export interface FleetHost {
  fleets(): Fleet[]
  /** The models a helper can be given, as "key (name)" lines for the tool's description. */
  roster(): string
  /** For a Claude conversation: Prism's agent running helpers on its behalf. Absent: the lead's own (ctx.spawnAgent, ctx.helpers). */
  kit?(sessionId: string): HelperKit | null
}

const keyOf = (m: ModelRef): string => `${m.endpointId}::${m.modelId}`

function kitFrom(host: FleetHost, ctx: ToolContext): HelperKit | null {
  if (host.kit) return host.kit(ctx.sessionId)
  const team = ctx.helpers?.team
  if (!team) return null
  return { spawn: (task, o) => ctx.spawnAgent(task, o), team: (spec, bg) => team(spec, bg) }
}

/** A fleet as a staged team: everyone at once, then the combiner reading every report. */
export function fleetTeam(f: Fleet, task: string): TeamSpec {
  const stages: TeamSpec['stages'] = [
    {
      title: 'Everyone on the task',
      agents: f.members.map((m) => ({ name: m.name, model: keyOf(m.model), readOnly: !m.canEdit, task: `${m.persona.trim() ? `${m.persona.trim()}\n\n` : ''}The task:\n${task}` }))
    }
  ]
  if (f.combine) {
    stages.push({
      title: 'One answer from all of them',
      agents: [{ name: 'combiner', model: keyOf(f.combine.model), readOnly: true, task: `${f.combine.persona.trim() || 'Read every report from the stage before and write one answer from them: where they agree, where they differ and what you would do.'}\n\nThe task they worked on:\n${task}` }]
    })
  }
  return { goal: `${f.name}: ${task.slice(0, 200)}`, stages }
}

export function createFleetTools(host: FleetHost): AgentTool[] {
  const helper: AgentTool = {
    spec: {
      name: 'prism_helper',
      get description() {
        return `Hand a self-contained task to a helper agent on any model Prism has, from any provider (GLM, Claude and the rest), with its own context. It cannot see this conversation: give complete instructions and say what to report back. Returns its report; background=true returns at once and the report comes later as a notice. It uses the user's account for that model. Models:\n${host.roster()}`
      },
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Complete instructions and what to report back' },
          model: { type: 'string', description: 'A model key from the list' },
          name: { type: 'string', description: 'Short label, e.g. "researcher"' },
          read_only: { type: 'boolean', description: 'Only reading and searching, no edits or commands' },
          background: { type: 'boolean', description: 'Return at once; the report comes later' }
        },
        required: ['task', 'model']
      }
    },
    primaryArg: null,
    readOnly: false,
    parallelSafe: true,
    risk: () => null,
    summary: (a) => `helper ${str(a, 'name', 'helper')} on ${str(a, 'model').split('::').pop()}`,
    async execute(args, ctx) {
      const kit = kitFrom(host, ctx)
      if (!kit) return err('Helpers are not available here.')
      const task = str(args, 'task').trim()
      if (!task) return err('Give the task.')
      const r = await kit.spawn(task, { name: str(args, 'name', 'helper'), model: str(args, 'model') || undefined, readOnly: bool(args, 'read_only'), background: bool(args, 'background') })
      return { content: r.summary || '(the helper returned nothing)', isError: !r.ok, meta: { subagent: str(args, 'name', 'helper') } }
    }
  }

  const list: AgentTool = {
    spec: {
      name: 'fleet_list',
      description: 'The fleets the user has saved: teams of helpers on Prism\'s models, each run by name with fleet_run.',
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'list the fleets',
    async execute() {
      const all = host.fleets()
      if (!all.length) return { content: 'No fleets yet. The user makes them in Settings, Fleets.', isError: false }
      return {
        content: all
          .map((f) => `- ${f.name}: ${f.description || '(no description)'}\n  ${f.members.map((m) => `${m.name} on ${m.model.modelId}${m.canEdit ? ', may change files' : ''}`).join('; ')}${f.combine ? `; then one answer from ${f.combine.model.modelId}` : ''}`)
          .join('\n'),
        isError: false
      }
    }
  }

  const run: AgentTool = {
    spec: {
      name: 'fleet_run',
      description: 'Run one of the user\'s saved fleets (fleet_list shows them) on a task: every member works on it at once with its own model and instructions, and a combiner (if the fleet has one) writes one answer from their reports. Give the task completely: they cannot see this conversation. background=true returns at once; the reports come later as a notice.',
      parameters: {
        type: 'object',
        properties: {
          fleet: { type: 'string', description: 'The fleet\'s name' },
          task: { type: 'string', description: 'Complete instructions and what to report back' },
          background: { type: 'boolean' }
        },
        required: ['fleet', 'task']
      }
    },
    primaryArg: null,
    readOnly: false,
    parallelSafe: true,
    risk: () => null,
    summary: (a) => `fleet ${str(a, 'fleet')}`,
    async execute(args, ctx) {
      const kit = kitFrom(host, ctx)
      if (!kit) return err('Fleets are not available here.')
      const name = str(args, 'fleet').trim().toLowerCase()
      const f = host.fleets().find((x) => x.name.toLowerCase() === name)
      if (!f) return err(`No fleet called "${str(args, 'fleet')}". Fleets: ${host.fleets().map((x) => x.name).join(', ') || 'none yet'}.`)
      if (!f.members.length) return err(`The fleet "${f.name}" has nobody in it yet.`)
      const task = str(args, 'task').trim()
      if (!task) return err('Give the task.')
      const r = await kit.team(fleetTeam(f, task), bool(args, 'background'))
      return { content: r.summary, isError: !r.ok }
    }
  }

  return [helper, list, run]
}

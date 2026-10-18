// Work that carries on after the agent's turn: background commands, output watchers, timers, helpers
// and messages between sessions. When any of it has news, Prism hands the agent a notice: in the middle
// of a turn it arrives before the next step; when the session is idle it starts a new turn (up to the
// user's limit of wake-ups in a row). The host (main/agent-host.ts) delivers notices and keeps timers;
// this module holds the shapes and the tools that do not need the engine.
import type { BackgroundState, HelperRecord, Wakeup } from '@shared/types'
import { parseEvery } from '../automations/automations'
import { err, str, type AgentTool, type ToolContext } from './tools/types'

export interface NoticeTarget {
  /** The session that should hear it: a helper's own session while it runs, else its lead's. */
  sessionId: string
  rootSessionId: string
}

export interface SessionBrief {
  id: string
  title: string
  status: 'idle' | 'running' | 'waiting'
  updatedAt: number
  lastWords: string
}

export interface BackgroundHost {
  /** Tell a session something. wake: start a turn when it is idle. */
  notify(target: NoticeTarget, text: string, meta: Record<string, unknown>, wake: boolean): void
  /** Something a session waits on changed (for the list in its header). */
  changed(rootSessionId: string): void
  /** Notices that arrived for this session while it was mid-turn; the engine takes them before each step. */
  drain(sessionId: string): import('@shared/types').SystemItem[]
  /** Whether news is waiting for this session (the engine carries on instead of ending the turn). */
  pending(sessionId: string): boolean
  /** The engine is running a loop for this session (a lead or a helper). */
  enter(sessionId: string, rootSessionId: string): void
  /** The loop ended; news that came too late for a helper goes on to its lead. */
  leave(sessionId: string): void
  timers: {
    add(rootSessionId: string, t: { dueAt: number; every?: string; note: string }): Wakeup
    list(rootSessionId: string): Wakeup[]
    cancel(rootSessionId: string, id: string): boolean
  }
  sessions: {
    list(rootSessionId: string): SessionBrief[]
    /** Deliver a message to another session in this project; its reply comes back as a notice when wantReply. */
    message(fromRootSessionId: string, toSessionId: string, text: string, wantReply: boolean): Promise<string>
  }
  copies: {
    /** A helper's own copy of the project, starting from the project as it is now (uncommitted changes included). */
    make(rootSessionId: string, name: string): Promise<{ path: string; branch: string; base: string }>
    /** Files the copy changed since it was made. */
    changes(copy: { path: string; base: string }): Promise<string[]>
    /** Bring the copy's changes into the project folder as ordinary edits. */
    apply(rootSessionId: string, copy: { path: string; base: string }): Promise<{ ok: boolean; files: string[]; output: string }>
    discard(rootSessionId: string, copy: { path: string; branch: string }): Promise<void>
  }
  state(rootSessionId: string): BackgroundState
}

/** Helpers this lead agent can reach: started, messaged, stopped, merged. Provided by the engine. */
export interface HelperControl {
  records(): HelperRecord[]
  running(name: string): boolean
  /** The most helpers one team may have (Settings, Agent). */
  maxTeam(): number
  message(name: string, text: string, background: boolean): Promise<{ ok: boolean; summary: string }>
  stop(name: string): boolean
  team(spec: TeamSpec, background: boolean): Promise<{ ok: boolean; summary: string }>
}

export interface TeamSpec {
  goal: string
  stages: Array<{ title: string; agents: Array<{ name: string; task: string; model?: string; readOnly?: boolean; isolated?: boolean }> }>
}

/** "10m", "2h", "90s", "1d", "1h30m" into milliseconds. */
export function parseDelay(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return null
  let total = 0
  let rest = t
  const units: Record<string, number> = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000 }
  while (rest) {
    const m = /^(\d+(?:\.\d+)?)(s|sec|m|min|h|hr|d)/.exec(rest)
    if (!m) return null
    total += Number(m[1]) * units[m[2]!]!
    rest = rest.slice(m[0].length)
  }
  return total > 0 ? total : null
}

/** "14:30" today, or tomorrow if that has passed. */
export function nextClock(hhmm: string, now = new Date()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** When a repeating timer goes off next, after `from`. */
export function nextDue(every: string, from: number): number | null {
  const p = parseEvery(every)
  if (!p) return null
  if ('intervalMs' in p) return from + p.intervalMs
  const d = new Date(from)
  d.setHours(Math.floor(p.dailyAt / 60), p.dailyAt % 60, 0, 0)
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  return d.getTime()
}

const when = (ms: number): string => {
  const secs = Math.round((ms - Date.now()) / 1000)
  const mins = Math.round(secs / 60)
  const clock = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return secs < 90 ? `in ${Math.max(0, secs)}s (${clock})` : mins < 120 ? `in ${mins} min (${clock})` : `at ${new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

function bg(ctx: ToolContext): NonNullable<ToolContext['background']> | null {
  return ctx.background ?? null
}

const noHost = err('Background work is not available here.')

export function createBackgroundTools(): AgentTool[] {
  const wakeMe: AgentTool = {
    spec: {
      name: 'wake_me',
      description:
        'Set a timer that wakes you later with a note, even after your turn has ended: "check the deploy again in 10 minutes", "look at CI at 14:30", "every morning at 9 summarise new issues". ' +
        'Give in (a delay like "10m", "2h", "1h30m"), or at ("14:30"), and optionally every ("30m", "2h", "daily at 09:00") to repeat. The note is what you will be told when it goes off, so make it say what to do. ' +
        'Never set one to check on a background command, a helper or a team, or to wait for another session\'s reply: you are told about all of those automatically. Timers are for things nothing will tell you about (a CI run, a deploy elsewhere, a reminder).',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'What to do when it goes off' },
          in: { type: 'string', description: 'Delay, e.g. "10m", "2h"' },
          at: { type: 'string', description: 'Clock time today (or tomorrow), e.g. "14:30"' },
          every: { type: 'string', description: 'Repeat: "30m", "2h", "daily at 09:00"' }
        },
        required: ['note']
      }
    },
    primaryArg: 'note',
    readOnly: false,
    risk: () => null,
    summary: (a) => `wake me ${str(a, 'in') ? `in ${str(a, 'in')}` : str(a, 'at') ? `at ${str(a, 'at')}` : str(a, 'every') ? `every ${str(a, 'every')}` : ''}: ${str(a, 'note').slice(0, 60)}`,
    async execute(args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      const note = str(args, 'note').trim()
      if (!note) return err('Say what the timer is for.')
      const every = str(args, 'every').trim()
      if (every && !parseEvery(every)) return err(`"${every}" is not a repeat Prism understands. Use "30m", "2h" or "daily at 09:00".`)
      const delay = str(args, 'in').trim() ? parseDelay(str(args, 'in')) : null
      if (str(args, 'in').trim() && delay === null) return err(`"${str(args, 'in')}" is not a delay Prism understands. Use "10m", "2h" or "1h30m".`)
      const at = str(args, 'at').trim() ? nextClock(str(args, 'at')) : null
      if (str(args, 'at').trim() && at === null) return err(`"${str(args, 'at')}" is not a time. Use 24-hour "HH:MM".`)
      const dueAt = delay !== null ? Date.now() + delay : (at ?? (every ? nextDue(every, Date.now()) : null))
      if (dueAt === null) return err('Give in, at or every.')
      if (dueAt - Date.now() < 20_000) return err('That is too soon for a timer. Wait in this turn instead (job_output with wait_ms), or set at least 20 seconds.')
      const w = b.host.timers.add(b.rootSessionId, { dueAt, ...(every ? { every } : {}), note })
      return { content: `Timer ${w.id} set: goes off ${when(w.dueAt)}${every ? `, then every ${every}` : ''}. You will be woken with your note. cancel_wakeup ${w.id} stops it.`, isError: false, meta: { wakeup: w.id } }
    }
  }

  const listWaits: AgentTool = {
    spec: {
      name: 'list_waiting',
      description: 'What this session is waiting on in the background: commands still running (and what is being watched in them), timers, and helpers still at work.',
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'what am I waiting on',
    async execute(_args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      const s = b.host.state(b.rootSessionId)
      const lines: string[] = []
      for (const j of s.jobs) lines.push(`- job ${j.id}: ${j.command.slice(0, 100)} (running ${Math.round((Date.now() - j.startedAt) / 1000)}s${j.watching.length ? `; watching for ${j.watching.join(', ')}` : ''})`)
      for (const t of s.timers) lines.push(`- timer ${t.id}: ${when(t.dueAt)}${t.every ? `, every ${t.every}` : ''}: ${t.note}`)
      for (const h of s.helpers) lines.push(`- helper ${h.name}${h.isolated ? ' (own copy)' : ''}: ${h.running ? 'working' : 'finished'}: ${h.task.slice(0, 100)}`)
      return { content: lines.length ? lines.join('\n') : 'Nothing is running or scheduled in the background.', isError: false }
    }
  }

  const cancelWakeup: AgentTool = {
    spec: {
      name: 'cancel_wakeup',
      description: 'Cancel a timer set with wake_me.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    },
    primaryArg: 'id',
    readOnly: false,
    risk: () => null,
    summary: (a) => `cancel timer ${str(a, 'id')}`,
    async execute(args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      return b.host.timers.cancel(b.rootSessionId, str(args, 'id').trim()) ? { content: 'Cancelled.', isError: false } : err('No such timer. list_waiting shows them.')
    }
  }

  const listSessions: AgentTool = {
    spec: {
      name: 'list_sessions',
      description: 'The other agent sessions in this project (each is its own conversation, possibly working on something else right now), with what each last said. Use with message_session.',
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'other sessions',
    async execute(_args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      const all = b.host.sessions.list(b.rootSessionId)
      if (!all.length) return { content: 'No other sessions in this project.', isError: false }
      return {
        content: all.map((s) => `- ${s.id.slice(0, 8)} "${s.title}" (${s.status}, last active ${new Date(s.updatedAt).toLocaleString()})${s.lastWords ? `\n  last said: ${s.lastWords.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('\n'),
        isError: false
      }
    }
  }

  const messageSession: AgentTool = {
    spec: {
      name: 'message_session',
      description:
        'Send a message to another session in this project (see list_sessions): to hand over work, ask what it found, or tell it something changed. ' +
        'It arrives there as a notice: if that session is working it sees it before its next step, otherwise it starts working on it. ' +
        'With reply=true (the default) its answer comes back to you as a notice when it finishes. Say who you are and what you need; it cannot see this conversation.',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session id (the first 8 characters are enough) or exact title' },
          message: { type: 'string' },
          reply: { type: 'boolean', description: 'Have its answer sent back to you (default true)' }
        },
        required: ['session', 'message']
      }
    },
    primaryArg: 'session',
    readOnly: false,
    risk: () => 'low',
    summary: (a) => `message session ${str(a, 'session')}: ${str(a, 'message').slice(0, 60)}`,
    async execute(args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      const q = str(args, 'session').trim().toLowerCase()
      const all = b.host.sessions.list(b.rootSessionId)
      const to = all.find((s) => s.id.toLowerCase().startsWith(q)) ?? all.find((s) => s.title.toLowerCase() === q)
      if (!to) return err(`No other session matches "${str(args, 'session')}". list_sessions shows them.`)
      try {
        const r = await b.host.sessions.message(b.rootSessionId, to.id, str(args, 'message'), args['reply'] !== false)
        return { content: r, isError: false }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const watchJob: AgentTool = {
    spec: {
      name: 'watch_job',
      description:
        'Be told when a line matching a pattern appears in a background job\'s output (started with shell background=true): a dev server logging an error, "compiled successfully", a test failing, a deploy finishing. ' +
        'Matching lines reach you as notices (grouped when several come together), during this turn or by waking you later. pattern is a regular expression, case-insensitive. Stops after `times` matches (default 5) or when the job ends.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The job id' },
          pattern: { type: 'string', description: 'Regular expression, e.g. "error|failed" or "ready on port \\\\d+"' },
          times: { type: 'number', description: 'How many matches before it stops watching (default 5, max 50)' }
        },
        required: ['id', 'pattern']
      }
    },
    primaryArg: 'id',
    readOnly: true,
    risk: () => null,
    summary: (a) => `watch job ${str(a, 'id')} for /${str(a, 'pattern')}/`,
    async execute(args, ctx) {
      const b = bg(ctx)
      if (!b) return noHost
      if (!ctx.watchJob) return noHost
      let re: RegExp
      try {
        re = new RegExp(str(args, 'pattern'), 'i')
      } catch (e) {
        return err(`That pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`)
      }
      const times = Math.max(1, Math.min(50, Math.floor(Number(args['times'] ?? 5)) || 5))
      const r = ctx.watchJob(str(args, 'id').trim(), re, times)
      return r.ok ? { content: `Watching job ${str(args, 'id')} for /${re.source}/ (up to ${times} times).`, isError: false } : err(r.error)
    }
  }

  return [wakeMe, listWaits, cancelWakeup, listSessions, messageSession, watchJob]
}

/** Tools for a lead agent's helpers beyond spawn_agent: message, stop, bring in their work, and run teams. */
export function createHelperTools(): AgentTool[] {
  const message: AgentTool = {
    spec: {
      name: 'message_agent',
      description:
        'Talk to a helper you started with spawn_agent. If it is still working, your message reaches it before its next step (to redirect it or add information). ' +
        'If it has finished, it carries on from where it left off with everything it knew, and does what the message asks; its new report comes back like spawn_agent\'s (or as a notice later, with background=true).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The helper\'s name' },
          message: { type: 'string' },
          background: { type: 'boolean', description: 'When it has finished: let it carry on in the background and tell you when done' }
        },
        required: ['name', 'message']
      }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: () => null,
    summary: (a) => `to ${str(a, 'name')}: ${str(a, 'message').slice(0, 70)}`,
    parallelSafe: true,
    async execute(args, ctx) {
      if (!ctx.helpers) return err('Only the lead agent can talk to helpers.')
      const r = await ctx.helpers.message(str(args, 'name').trim(), str(args, 'message'), args['background'] === true)
      return { content: r.summary, isError: !r.ok }
    }
  }

  const stop: AgentTool = {
    spec: {
      name: 'stop_agent',
      description: 'Stop a helper that is still working.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: () => null,
    summary: (a) => `stop helper ${str(a, 'name')}`,
    async execute(args, ctx) {
      if (!ctx.helpers) return err('Only the lead agent can stop helpers.')
      return ctx.helpers.stop(str(args, 'name').trim()) ? { content: 'Stopped.', isError: false } : err('No helper by that name is working.')
    }
  }

  const merge: AgentTool = {
    spec: {
      name: 'merge_agent_work',
      description:
        'For a helper started with isolated=true (it worked in its own copy of the project): bring its changes into the project as ordinary edits (action "merge"; they can be undone like any edit), or throw its copy away ("discard"). "files" lists what it changed without doing either.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, action: { type: 'string', enum: ['merge', 'discard', 'files'] } },
        required: ['name', 'action']
      }
    },
    primaryArg: 'name',
    readOnly: false,
    risk: (a) => (str(a, 'action') === 'files' ? null : 'medium'),
    summary: (a) => `${str(a, 'action')} ${str(a, 'name')}'s work`,
    async execute(args, ctx) {
      const b = ctx.background
      if (!b || !ctx.helpers) return err('Only the lead agent can bring in helpers\' work.')
      const name = str(args, 'name').trim()
      const rec = ctx.helpers.records().find((h) => h.name === name)
      if (!rec) return err(`No helper called "${name}".`)
      if (!rec.copy) return err(`${name} worked in the project folder itself; its changes are already there.`)
      if (ctx.helpers.running(name)) return err(`${name} is still working. Wait for it, or stop_agent first.`)
      const action = str(args, 'action')
      try {
        if (action === 'files') {
          const files = await b.host.copies.changes(rec.copy)
          return { content: files.length ? `${name} changed:\n${files.map((f) => `- ${f}`).join('\n')}` : `${name} changed nothing.`, isError: false }
        }
        if (action === 'discard') {
          await b.host.copies.discard(b.rootSessionId, rec.copy)
          return { content: `Threw away ${name}'s copy.`, isError: false }
        }
        const files = await b.host.copies.changes(rec.copy)
        if (!files.length) return { content: `${name} changed nothing; there is nothing to bring in.`, isError: false }
        await ctx.checkpoint(files)
        const r = await b.host.copies.apply(b.rootSessionId, rec.copy)
        for (const f of r.files) ctx.emit({ type: 'file-touched', path: f, op: 'write' })
        return { content: r.ok ? `Brought in ${r.files.length} file${r.files.length === 1 ? '' : 's'} from ${name}: ${r.files.join(', ')}. The copy is kept until you discard it.` : `Could not bring all of ${name}'s work in:\n${r.output}`, isError: !r.ok }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    }
  }

  const team: AgentTool = {
    spec: {
      name: 'run_team',
      description:
        'Run a team of helpers through stages, for work too big for one helper: e.g. stage 1 "review" (three helpers, each checking a different part), stage 2 "verify" (helpers that check each other\'s findings), stage 3 "fix". ' +
        'Helpers in a stage work at the same time; each stage gets every report from the stages before it. Each agent\'s task must be complete on its own: they cannot see this conversation. ' +
        'Returns every report; with background=true you carry on and the reports come to you as a notice when the team is done.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the whole team is for (every helper is told)' },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                agents: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, task: { type: 'string' }, model: { type: 'string' }, read_only: { type: 'boolean' }, isolated: { type: 'boolean' } },
                    required: ['name', 'task']
                  }
                }
              },
              required: ['title', 'agents']
            }
          },
          background: { type: 'boolean' }
        },
        required: ['goal', 'stages']
      }
    },
    primaryArg: 'goal',
    readOnly: false,
    risk: () => null,
    summary: (a) => `team: ${str(a, 'goal').slice(0, 80)}`,
    async execute(args, ctx) {
      if (!ctx.helpers) return err('Only the lead agent can run a team.')
      const raw = Array.isArray(args['stages']) ? (args['stages'] as Array<Record<string, unknown>>) : []
      const stages: TeamSpec['stages'] = raw.map((s) => ({
        title: String(s['title'] ?? 'stage'),
        agents: (Array.isArray(s['agents']) ? (s['agents'] as Array<Record<string, unknown>>) : []).map((a) => ({
          name: String(a['name'] ?? 'helper'),
          task: String(a['task'] ?? ''),
          ...(typeof a['model'] === 'string' ? { model: a['model'] } : {}),
          readOnly: a['read_only'] === true,
          isolated: a['isolated'] === true
        }))
      }))
      if (!stages.length || stages.some((s) => !s.agents.length || s.agents.some((a) => !a.task.trim()))) return err('Every stage needs at least one agent, and every agent a task.')
      const n = stages.reduce((k, s) => k + s.agents.length, 0)
      const max = ctx.helpers.maxTeam()
      if (n > max) return err(`That is ${n} helpers; the user allows ${max} at most in one team (Settings, Agent).`)
      const r = await ctx.helpers.team({ goal: str(args, 'goal'), stages }, args['background'] === true)
      return { content: r.summary, isError: !r.ok }
    }
  }

  return [message, stop, merge, team]
}

// A lead agent's helpers: started by spawn_agent (waited for, or in the background), each with a name
// and its own session, so the lead can message one while it works, carry a finished one on with
// everything it knew, stop it, give it its own copy of the project, or run several as a team.
import { existsSync } from 'node:fs'
import type { AgentEvent, HelperRecord, ModelRef } from '@shared/types'
import { Workspace } from '../fs/workspace'
import type { HelperControl, TeamSpec } from './background'
import type { EngineDeps, RunInput, RunOutcome } from './engine'

interface Live {
  controller: AbortController
  done: Promise<RunOutcome>
  startedAt: number
}

// root session id -> helper name -> the run in progress
const live = new Map<string, Map<string, Live>>()

export function runningHelpers(rootSessionId: string): string[] {
  return [...(live.get(rootSessionId)?.keys() ?? [])]
}

export function stopHelper(rootSessionId: string, name: string): boolean {
  const h = live.get(rootSessionId)?.get(name)
  if (!h) return false
  h.controller.abort()
  return true
}

/** Stop every helper of a session (the session is being deleted, or the app is closing). */
export function stopAllHelpers(rootSessionId?: string): void {
  for (const [root, m] of live) if (!rootSessionId || root === rootSessionId) for (const h of m.values()) h.controller.abort()
}

type RunTurn = (deps: EngineDeps, input: RunInput) => Promise<RunOutcome>

const clean = (name: string): string => name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'helper'

export function createHelpers(deps: EngineDeps, input: RunInput, runTurn: RunTurn, emit: (ev: AgentEvent) => void): {
  spawn(task: string, opts: { name?: string; model?: string; readOnly?: boolean; background?: boolean; isolated?: boolean }): Promise<{ ok: boolean; summary: string }>
  control: HelperControl
} {
  const root = input.rootSessionId
  const host = deps.background
  const records = (): HelperRecord[] => deps.repo.getSessionExtras(root).helpers ?? []
  const saveRecord = (rec: HelperRecord): void => {
    deps.repo.setSessionExtras(root, { helpers: [...records().filter((h) => h.name !== rec.name), rec] })
  }
  const running = (name: string): boolean => !!live.get(root)?.has(name)
  const freeName = (want: string): string => {
    const taken = new Set([...records().map((h) => h.name), ...runningHelpers(root)])
    if (!taken.has(want)) return want
    for (let i = 2; ; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`
  }

  /** Runs one helper turn: a fresh task, or more for one that has finished. Resolves with its report. */
  const runHelper = async (rec: HelperRecord, text: string, opts: { linkToLead: boolean }): Promise<{ ok: boolean; summary: string }> => {
    const copyOk = rec.copy && existsSync(rec.copy.path)
    if (rec.copy && !copyOk) return { ok: false, summary: `${rec.name}'s copy of the project is gone; start a new helper.` }
    const ws = copyOk ? new Workspace(rec.copy!.path) : null
    const childDeps: EngineDeps = ws ? { ...deps, workspace: ws } : deps
    const controller = new AbortController()
    const onLeadStop = (): void => controller.abort()
    if (opts.linkToLead) input.signal.addEventListener('abort', onLeadStop, { once: true })
    emit({ type: 'subagent-start', agent: rec.name, task: text, model: rec.model })
    const st = Date.now()
    const done = runTurn(childDeps, {
      sessionId: rec.sessionId,
      rootSessionId: root,
      model: rec.model,
      mode: input.mode,
      text,
      attachments: [],
      agent: rec.name,
      depth: input.depth + 1,
      readOnly: rec.readOnly,
      signal: controller.signal,
      sessionAllow: input.sessionAllow,
      turnItemId: input.turnItemId,
      ...(copyOk
        ? { systemExtra: `You are working in your own copy of the project (a git worktree at ${rec.copy!.path}), started from the project as it was when you were given the task. Nothing you change reaches the user's project until the lead agent brings it in, so work freely. Dependencies may not be installed in this copy: install them first if a build or test needs them. Do not switch branches or commit.` }
        : {})
    })
    let m = live.get(root)
    if (!m) live.set(root, (m = new Map()))
    m.set(rec.name, { controller, done, startedAt: st })
    host?.changed(root)
    try {
      const r = await done
      const ok = r.reason === 'completed' || r.reason === 'max-steps'
      let summary = r.lastText || (r.error ? `${rec.name} failed: ${r.error}` : r.reason === 'aborted' ? `${rec.name} was stopped.` : '(no report)')
      if (copyOk && host) {
        const files = await host.copies.changes(rec.copy!).catch(() => [])
        summary += files.length
          ? `\n\n[${rec.name} worked in its own copy and changed ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 30).join(', ')}${files.length > 30 ? ', …' : ''}. Bring them in with merge_agent_work (action "merge"), or "discard".]`
          : `\n\n[${rec.name} worked in its own copy and changed nothing.]`
      }
      emit({ type: 'subagent-end', agent: rec.name, ok, summary: summary.slice(0, 2000), durationMs: Date.now() - st })
      return { ok, summary }
    } finally {
      input.signal.removeEventListener('abort', onLeadStop)
      live.get(root)?.delete(rec.name)
      ws?.close()
      host?.changed(root)
    }
  }

  const tellLead = (name: string, r: { ok: boolean; summary: string }, mins: number): void => {
    host?.notify({ sessionId: root, rootSessionId: root }, `Helper "${name}" ${r.ok ? 'finished' : 'stopped without finishing'}${mins >= 1 ? ` after ${mins} min` : ''}. Its report:\n\n${r.summary}`, { source: 'helper', helper: name, ok: r.ok }, true)
  }

  const newRecord = async (want: string, task: string, o: { model?: string; readOnly?: boolean; isolated?: boolean }): Promise<HelperRecord> => {
    const name = freeName(clean(want))
    const model: ModelRef = (o.model && deps.findModel(o.model)) || input.model
    let copy: HelperRecord['copy'] = null
    if (o.isolated) {
      if (!host) throw new Error('A helper with its own copy is not available here.')
      copy = await host.copies.make(root, name)
    }
    const child = deps.repo.createSession(deps.workspace.root, `${name}: ${task.slice(0, 50)}`, model, input.mode, input.sessionId)
    const rec: HelperRecord = { name, sessionId: child.id, task: task.slice(0, 500), model, readOnly: o.readOnly ?? false, copy, startedAt: Date.now() }
    saveRecord(rec)
    return rec
  }

  const spawn = async (task: string, opts: { name?: string; model?: string; readOnly?: boolean; background?: boolean; isolated?: boolean }): Promise<{ ok: boolean; summary: string }> => {
    if (input.depth > 0) return { ok: false, summary: 'Helpers cannot start helpers of their own.' }
    let rec: HelperRecord
    try {
      rec = await newRecord(opts.name ?? 'helper', task, opts)
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e) }
    }
    if (!opts.background) return runHelper(rec, task, { linkToLead: true })
    const st = Date.now()
    void runHelper(rec, task, { linkToLead: false }).then((r) => tellLead(rec.name, r, Math.round((Date.now() - st) / 60_000)))
    return { ok: true, summary: `Started helper "${rec.name}" in the background${rec.copy ? ', in its own copy of the project' : ''}. You will be told when it finishes; meanwhile carry on. message_agent "${rec.name}" talks to it; stop_agent stops it.` }
  }

  const control: HelperControl = {
    records,
    running,
    maxTeam: () => Math.max(1, deps.settings().agent.maxTeam ?? 12),
    async message(name, text, background) {
      const rec = records().find((h) => h.name === name)
      if (!rec) return { ok: false, summary: `No helper called "${name}". Helpers so far: ${records().map((h) => h.name).join(', ') || 'none'}.` }
      if (running(name)) {
        if (!host) return { ok: false, summary: 'Messages to a working helper are not available here.' }
        host.notify({ sessionId: rec.sessionId, rootSessionId: root }, `Message from the lead agent:\n${text}`, { source: 'lead' }, false)
        return { ok: true, summary: `Delivered to ${name}; it sees it before its next step. Its report still comes when it finishes.` }
      }
      if (!background) return runHelper(rec, text, { linkToLead: true })
      const st = Date.now()
      void runHelper(rec, text, { linkToLead: false }).then((r) => tellLead(name, r, Math.round((Date.now() - st) / 60_000)))
      return { ok: true, summary: `${name} is carrying on in the background. You will be told when it finishes.` }
    },
    stop: (name) => stopHelper(root, name),
    async team(spec: TeamSpec, background) {
      const runTeam = async (): Promise<{ ok: boolean; summary: string }> => {
        const reports: string[] = []
        let ok = true
        for (const [i, stage] of spec.stages.entries()) {
          const before = reports.length ? `\n\nReports from the stages before yours:\n\n${reports.join('\n\n')}` : ''
          const results = await Promise.all(
            stage.agents.map(async (a) => {
              try {
                const rec = await newRecord(a.name, a.task, a)
                const r = await runHelper(rec, `You are one of a team of helpers. The team's goal: ${spec.goal}\nThis stage: ${stage.title} (stage ${i + 1} of ${spec.stages.length}).\n\nYour task:\n${a.task}${before}`, { linkToLead: !background })
                return { name: rec.name, ...r }
              } catch (e) {
                return { name: a.name, ok: false, summary: e instanceof Error ? e.message : String(e) }
              }
            })
          )
          if (results.some((r) => !r.ok)) ok = false
          reports.push(`## Stage ${i + 1}: ${stage.title}\n\n${results.map((r) => `### ${r.name}${r.ok ? '' : ' (did not finish)'}\n${r.summary}`).join('\n\n')}`)
          if (input.signal.aborted && !background) break
        }
        return { ok, summary: `Team "${spec.goal}" ${ok ? 'finished' : 'finished, but not every helper completed'}.\n\n${reports.join('\n\n')}` }
      }
      if (!background) return runTeam()
      const st = Date.now()
      void runTeam().then((r) => host?.notify({ sessionId: root, rootSessionId: root }, `${r.summary}${Date.now() - st > 60_000 ? `\n\n(The team took ${Math.round((Date.now() - st) / 60_000)} min.)` : ''}`, { source: 'team', ok: r.ok }, true))
      return { ok: true, summary: `The team is working in the background (${spec.stages.length} stage${spec.stages.length === 1 ? '' : 's'}). You will get every report as a notice when it is done; carry on meanwhile.` }
    }
  }

  return { spawn, control }
}

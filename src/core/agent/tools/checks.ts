import { detectCheckers, runChecker } from '../../checks/checks'
import { err, str, type AgentTool } from './types'

/** The project's own checkers as one tool, so the agent verifies its work the way the project does. */
export const checkProjectTool: AgentTool = {
  spec: {
    name: 'check_project',
    description:
      "Run the project's own checkers (type checker, linter, compiler, tests) and get the problems as file:line:column with messages. " +
      'Call it with no arguments to see which checkers this project has. Pass a checker id, or "all" for every type and lint checker (tests only run when named). ' +
      'Use it after you change code, before you say the work is done.',
    parameters: {
      type: 'object',
      properties: { checker: { type: 'string', description: 'A checker id from the list, or "all". Omit to list the checkers.' } }
    }
  },
  primaryArg: 'checker',
  readOnly: true,
  // listing is free; running executes the project's own commands, like the shell tool does
  risk: (a) => (str(a, 'checker') ? 'medium' : null),
  summary: (a) => (str(a, 'checker') ? `check the project: ${str(a, 'checker')}` : 'list project checkers'),
  async execute(args, ctx) {
    const root = ctx.workspace.root
    const all = detectCheckers(root)
    const which = str(args, 'checker').trim()
    if (!which) {
      if (!all.length) return { content: 'No checkers found for this project (no tsconfig.json, linter config, Cargo.toml, go.mod, Python config or test script). Checkers can be added in .prism/checks.json as [{ "label": "…", "command": "…" }].', isError: false }
      return { content: all.map((c) => `- ${c.id} (${c.kind}): ${c.command}`).join('\n'), isError: false }
    }
    const targets = which === 'all' ? all.filter((c) => c.kind !== 'test') : all.filter((c) => c.id === which)
    if (!targets.length) return err(`No checker named "${which}". Available: ${all.map((c) => c.id).join(', ') || 'none'}`)
    const parts: string[] = []
    const results: Array<Omit<Awaited<ReturnType<typeof runChecker>>, 'output'>> = []
    let total = 0
    let failed = false
    for (const c of targets) {
      if (ctx.signal.aborted) break
      const r = await runChecker(root, c.id, ctx.signal)
      total += r.problems.length
      results.push({ checker: r.checker, problems: r.problems, code: r.code, durationMs: r.durationMs, ...(r.note ? { note: r.note } : {}) })
      if (r.code !== 0) failed = true
      const head = `## ${c.label} — ${r.note ?? (r.code === 0 && !r.problems.length ? 'passed' : `${r.problems.length} problem(s), exit code ${r.code}`)} (${(r.durationMs / 1000).toFixed(1)}s)`
      const list = r.problems.slice(0, 80).map((p) => `${p.file}:${p.line}:${p.column}: ${p.severity}${p.code ? ` ${p.code}` : ''}: ${p.message}`)
      // when nothing could be parsed, the raw tail is all there is to go on
      const tail = r.code !== 0 && !r.problems.length ? `\n${r.output.trim().split('\n').slice(-40).join('\n')}` : ''
      parts.push([head, ...list, r.problems.length > 80 ? `… and ${r.problems.length - 80} more` : ''].filter(Boolean).join('\n') + tail)
    }
    return { content: parts.join('\n\n'), isError: false, meta: { problems: total, failed, results } }
  }
}

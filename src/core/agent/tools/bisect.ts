import { findBreakingCommit } from '../../git/bisect'
import { err, str, type AgentTool } from './types'

const RUNNERS: Record<string, string> = { js: 'node {script}', mjs: 'node {script}', cjs: 'node {script}', ts: 'npx --yes tsx {script}', py: 'python {script}', sh: 'bash {script}', ps1: 'powershell -NoProfile -File {script}' }

export const findBreakingCommitTool: AgentTool = {
  spec: {
    name: 'find_breaking_commit',
    description:
      'Find the commit that broke something, with git bisect, without touching the user\'s files (it tests older versions in a separate checkout). First write a small reproduction script in the project (for example .prism/bisect/repro.mjs) that exits with code 0 when the behaviour is right and 1 when it is broken (125: cannot tell for this version). It runs from the project root of each older version, so import project files with paths relative to the script. Run it once yourself to check it fails now. Then call this. If you do not know a version where it worked, leave good empty and Prism looks back for one.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The reproduction script, relative to the project folder' },
        command: { type: 'string', description: 'How to run it, with {script} for its path. Optional: chosen from the file type.' },
        good: { type: 'string', description: 'A commit, tag or branch where it worked (optional)' },
        bad: { type: 'string', description: 'Where it is broken (default HEAD)' }
      },
      required: ['script']
    }
  },
  primaryArg: 'script',
  readOnly: false,
  // it runs the script against many versions: code running on the user's machine
  risk: () => 'medium',
  summary: (a) => `find the commit that broke ${str(a, 'script')}`,
  async execute(args, ctx) {
    const script = str(args, 'script').split('\\').join('/').replace(/^\.\//, '')
    if (!(await ctx.workspace.exists(script))) return err(`${script} does not exist. Write the reproduction script first.`)
    const ext = script.split('.').pop()?.toLowerCase() ?? ''
    const command = str(args, 'command') || RUNNERS[ext]
    if (!command) return err('Say how to run the script (command), with {script} where its path goes.')
    try {
      const r = await findBreakingCommit({
        root: ctx.workspace.root,
        script,
        command,
        good: str(args, 'good') || undefined,
        bad: str(args, 'bad') || undefined,
        signal: ctx.signal,
        progress: (line) => ctx.output(ctx.callId, line)
      })
      return {
        content: `The first commit where it is broken: ${r.commit.slice(0, 10)} "${r.subject}" by ${r.author}, ${r.date} (found in ${r.steps} test runs; it worked at ${r.good.slice(0, 10)}).\n\nFiles it changed:\n${r.stat}\n\nIts changes:\n${r.diff}`,
        isError: false,
        meta: { bisect: { commit: r.commit, subject: r.subject, author: r.author, date: r.date, good: r.good, steps: r.steps } }
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  }
}

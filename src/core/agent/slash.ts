import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SlashCommand } from '@shared/types'
import type { Workspace } from '../fs/workspace'

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarise the conversation to free context', source: 'builtin' },
  { name: 'clear', description: 'Start a fresh session', source: 'builtin' },
  { name: 'init', description: 'Write a PRISM.md with project guidance for the agent', source: 'builtin', prompt: INIT_PROMPT() },
  { name: 'review', description: 'Review the uncommitted changes in the workspace', source: 'builtin', prompt: REVIEW_PROMPT() },
  { name: 'tour', description: 'Show me how something works, as a guided tour through the code', source: 'builtin', prompt: TOUR_PROMPT() },
  { name: 'bisect', description: 'Something used to work: find the commit that broke it', source: 'builtin', prompt: BISECT_PROMPT() },
  { name: 'debug', description: 'Find the cause of a bug by logging what really happens, then fix it and remove the logging', source: 'builtin', prompt: DEBUG_PROMPT() },
  { name: 'side', description: 'Ask a passing question in a side chat, without derailing this conversation', source: 'builtin' },
  { name: 'btw', description: 'Same as /side: a passing question in a side chat', source: 'builtin' },
  { name: 'undo', description: 'Take back one part of what the agent changed, keeping the rest', source: 'builtin', prompt: UNDO_PROMPT() },
  { name: 'test', description: 'Find and run the project tests, fix failures', source: 'builtin', prompt: 'Find how this project runs its tests, run them, and fix any failures you can. Report what passed, what failed and what you changed.' },
  { name: 'explain', description: 'Explain the project structure', source: 'builtin', prompt: 'Explore this workspace and explain its structure, main technologies, entry points and how the pieces fit together. Be concrete and reference files.' },
  { name: 'commit', description: 'Stage and commit the current changes', source: 'builtin', prompt: 'Look at git status and git diff, then write a clear conventional commit message and commit the current changes. Do not push. Tell me the commit summary.' }
]

function INIT_PROMPT(): string {
  return `Explore this workspace (build system, test commands, main directories, conventions, gotchas) and write a concise PRISM.md at the workspace root that a coding agent should read before working here. Include: how to build/run/test, project layout, coding conventions, and anything surprising. Keep it under 120 lines. If PRISM.md already exists, improve it instead of replacing it.`
}

function TOUR_PROMPT(): string {
  return 'Make a guided tour of the code that shows me: $ARGUMENTS\n\nRead the code first and follow the real path through it. Then call create_tour with 4 to 12 steps in the order a newcomer should read them: where it starts, each place it goes, where it ends. For each step, copy the exact text of the line to land on, and write a note of one to four plain sentences: what happens here and why it matters. Afterwards, tell me in two sentences what the tour covers.'
}

function DEBUG_PROMPT(): string {
  return `Find and fix the cause of this problem, by looking at what really happens rather than guessing: $ARGUMENTS

1. Read the code involved. Work out two to four guesses at the cause, most likely first. Call debug_start with the problem and the guesses.
2. Add temporary logging that would tell the guesses apart: the values that matter, which branch ran, the order things happen in. Mark every added line as debug_start explains; mark nothing else.
3. Make the problem happen. If a test, a command or a page you can open reproduces it, do that yourself. Otherwise call debug_reproduce with exact steps for the user.
4. Read the log (debug_read) and say which guess it supports and why. If none fits, make new guesses, log again and repeat.
5. Fix the cause, not the symptom. Prove the fix: run what reproduced it again, or call debug_reproduce again so the user can confirm.
6. Call debug_cleanup. Then say in a few sentences what the cause was, what the log showed, and what you changed.`
}

function UNDO_PROMPT(): string {
  return `Take back this part of the changes made earlier in this session, and only this part: $ARGUMENTS

1. Call change_history to see every change this session made, which request each was for, and when.
2. Work out which of those changes (or which lines within them) belong to the part to take back. Use version_at to see files as they were before and after.
3. Put back just those lines with edit_file (or restore a deleted file, or delete one that was created only for this part). Keep every change that does not belong to it, including later work on the same files.
4. If it is not clear which changes the user means, ask before changing anything.
5. Say what you took back and what you kept.`
}

function BISECT_PROMPT(): string {
  return `Something that used to work is broken: $ARGUMENTS

Find the commit that broke it:
1. Work out exactly what "working" means here, reading the code as needed.
2. Write a small reproduction script at .prism/bisect/repro.<ext> that exits with code 0 when it works and 1 when it is broken (125 if a version cannot be tested, for example it does not build). It runs from the project folder of older versions, so keep it to the code under test and import project files with paths relative to the script.
3. Run it once to check that it fails now.
4. Call find_breaking_commit with it. Do not run git bisect or check out old commits yourself: that would move the user's files; the tool tests old versions in a separate checkout.
5. Explain what that commit changed and why it broke this, and propose a fix. Do not change any code until I say so.`
}

function REVIEW_PROMPT(): string {
  return `Review the uncommitted changes in this workspace (git diff, plus untracked files from git status). Look for bugs, missing error handling, security issues, and divergence from the project's conventions. Report findings ordered by severity with file:line references, then a short overall assessment. Do not change files.`
}

/** Custom commands: .prism/commands/<name>.md whose body is the prompt. First line "# title" or a "description:" frontmatter line is the description. */
export async function customCommands(ws: Workspace): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  const dir = join(ws.root, '.prism', 'commands')
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      const name = f.slice(0, -3)
      let description = ''
      let body = raw
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)
      if (fm) {
        body = raw.slice(fm[0].length)
        const d = fm[1]!.match(/description:\s*(.+)/)
        if (d) description = d[1]!.trim()
      }
      if (!description) {
        const h = body.match(/^#\s+(.+)/m)
        description = h ? h[1]!.trim() : `Custom command from .prism/commands/${f}`
      }
      out.push({ name, description, source: 'custom', prompt: body.trim() })
    } catch {
      /* skip unreadable */
    }
  }
  return out
}

/** Expand "/name rest of text" into a prompt. Returns null if not a command. */
export function expandSlash(text: string, commands: SlashCommand[]): { command: SlashCommand; prompt: string } | null {
  const m = text.match(/^\/([\w-]+)\s*([\s\S]*)$/)
  if (!m) return null
  const cmd = commands.find((c) => c.name === m[1])
  if (!cmd) return null
  const args = (m[2] ?? '').trim()
  let prompt = cmd.prompt ?? ''
  if (prompt.includes('$ARGUMENTS')) prompt = prompt.replace(/\$ARGUMENTS/g, args)
  else if (args) prompt = `${prompt}\n\n${args}`
  return { command: cmd, prompt }
}

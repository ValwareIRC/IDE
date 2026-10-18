// Skills: Markdown files of instructions that join the conversation only when
// they are relevant. A project keeps them in .prism/skills/, a person in the
// app's data folder (skills/). Each file may start with a small header:
//
//   ---
//   name: release-notes
//   description: How release notes are written here
//   when: release, changelog, version bump
//   always: false
//   ---
//
// `when` lists words or phrases; a message that contains one loads the skill.
// The agent sees the names and descriptions of the rest and can load one itself
// with use_skill. A skill stays for the rest of the session once loaded.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInfo } from '@shared/types'
import type { Workspace } from '../fs/workspace'
import { TOOL_TEMPLATE } from '@shared/extend'

export interface Skill extends SkillInfo {
  body: string
}

const MAX_BODY = 12_000
const PROJECT_DIR = '.prism/skills'

/** Comes with Prism: how to write skills and tools, loaded only when the user asks for one. */
const EXTENDING: Skill = {
  name: 'extending-prism',
  description: 'How to write a skill (instructions that load when relevant) or a custom tool for this project',
  when: ['new skill', 'a skill', 'write a skill', 'make a skill', 'create a skill', 'custom tool', 'own tool', 'new tool', 'a tool', 'make a tool', 'write a tool', 'create a tool', '.prism/skills', '.prism/tools'],
  always: false,
  scope: 'builtin',
  path: '',
  body: `Prism can be taught things in two ways. Both are plain files in the project.

## Skills: \`.prism/skills/<name>.md\`
A page of instructions that joins the conversation only when it is relevant. Start the file with a header, then write the instructions in Markdown:

\`\`\`
---
name: release-notes
description: How release notes are written in this project
when: release notes, changelog, version bump
---
\`\`\`

- \`when\` is a comma-separated list of words or short phrases; a message from the user containing one (as a whole word or phrase) loads the skill. Choose words the user would really type. \`always: true\` loads it in every session instead.
- Keep a skill to one subject and under a couple of pages. Write what to do, in the order to do it, and what to check at the end.
- A skill takes effect from the user's next message; nothing needs allowing.

## Tools: \`.prism/tools/<name>.ts\`
One TypeScript file per tool. It is plain JavaScript/TypeScript with no imports: no Node modules, no fetch, no file system. Everything it may do is on the \`prism\` object passed to \`run\`:

- \`prism.fs.read(path)\`, \`prism.fs.write(path, content)\`, \`prism.fs.list(path)\`, \`prism.fs.exists(path)\`, \`prism.fs.search(query, { regex, caseSensitive, include })\`: project files only, paths relative to the project folder.
- \`prism.shell.run(command, { timeoutMs })\` gives \`{ code, output }\`: only with \`uses: ['shell']\`.
- \`prism.fetch(url, { method, headers, body })\` gives \`{ status, ok, text }\`: only with \`uses: ['network']\`.
- \`prism.log(...)\` adds lines shown to you after the result. \`URL\`, \`URLSearchParams\`, \`setTimeout\`, \`JSON\`, \`Math\`, \`Date\` and the rest of the language are there.

Parameter types are string, number, boolean, array or object; add \`optional: true\` for one that may be left out. What \`run\` returns (a string, or anything JSON can hold) is the tool's result. A call is stopped after two minutes. This is a complete tool:

\`\`\`ts
${TOOL_TEMPLATE('count_lines').trim()}
\`\`\`

After you write or change a tool file, the user has to allow it before it is offered to you: tell them to open Settings, "Skills & tools", look at the file and press Allow. Do not set \`risk: 'none'\` unless the user asked for a tool that never asks first. If a tool fails to load, the same page shows why.`
}

function parse(file: string, raw: string, scope: 'project' | 'personal', path: string): Skill {
  let body = raw
  const head: Record<string, string> = {}
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (fm) {
    body = raw.slice(fm[0].length)
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line)
      if (m) head[m[1]!.toLowerCase()] = m[2]!.trim()
    }
  }
  const name = (head['name'] || file.replace(/\.md$/i, '')).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
  return {
    name,
    description: head['description'] || title || `Instructions from ${file}`,
    when: (head['when'] ?? head['triggers'] ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),
    always: /^(true|yes|1)$/i.test(head['always'] ?? ''),
    scope,
    path,
    body: body.trim().slice(0, MAX_BODY)
  }
}

/** Every skill available to a workspace: the project's, then the person's own (a project skill wins a name clash). */
export async function loadSkills(ws: Workspace, personalDir: string): Promise<Skill[]> {
  const out: Skill[] = []
  try {
    for (const e of await ws.list(PROJECT_DIR)) {
      if (e.kind !== 'file' || !/\.md$/i.test(e.name)) continue
      try {
        out.push(parse(e.name, (await ws.read(e.path)).content, 'project', e.path))
      } catch {
        /* unreadable: skip it */
      }
    }
  } catch {
    /* the project has no skills folder */
  }
  if (existsSync(personalDir)) {
    for (const f of readdirSync(personalDir)) {
      if (!/\.md$/i.test(f)) continue
      try {
        const s = parse(f, readFileSync(join(personalDir, f), 'utf8'), 'personal', join(personalDir, f))
        if (!out.some((x) => x.name === s.name)) out.push(s)
      } catch {
        /* skip */
      }
    }
  }
  if (!out.some((x) => x.name === EXTENDING.name)) out.push(EXTENDING)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The skills a message calls for: those marked always, and those with a trigger word or phrase in the text. */
export function matchSkills(skills: Skill[], text: string): Skill[] {
  const t = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `
  const has = (w: string): boolean => {
    // a whole word or phrase, so "test" does not fire on "latest"
    const i = t.indexOf(w)
    if (i < 0) return false
    const before = t[i - 1] ?? ' '
    const after = t[i + w.length] ?? ' '
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)
  }
  return skills.filter((s) => s.always || s.when.some(has))
}

/** A turn's skills: those the session already uses, plus those this message calls for. `fresh` are the ones new this turn. */
export function pickSkills(all: Skill[], inUse: string[], text: string): { loaded: Skill[]; others: Skill[]; fresh: Skill[] } {
  const matched = text.trim() ? matchSkills(all, text) : all.filter((s) => s.always)
  const loaded = all.filter((s) => inUse.includes(s.name) || matched.includes(s))
  return { loaded, others: all.filter((s) => !loaded.includes(s)), fresh: loaded.filter((s) => !inUse.includes(s.name)) }
}

/** The line shown in the conversation when skills join it. */
export function skillNote(fresh: Skill[]): string {
  return fresh.length === 1 ? `Using the skill "${fresh[0]!.name}": ${fresh[0]!.description}` : `Using the skills ${fresh.map((s) => `"${s.name}"`).join(', ')}`
}

/** The part of the system prompt about skills: the loaded ones in full, the others by name. */
export function skillsPrompt(loaded: Skill[], others: Skill[], tool = 'use_skill'): string {
  const parts: string[] = []
  if (loaded.length) {
    parts.push(`## Skills in use\nThese are this project's own instructions for the kind of work at hand. Follow them.\n\n${loaded.map((s) => `### ${s.name}\n${s.body}`).join('\n\n')}`)
  }
  if (others.length) {
    parts.push(`## Other skills\nInstructions you can load with ${tool} when the work calls for them:\n${others.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

// Text shared by the main process (which writes these files into a project) and
// the editor (which uses the type declarations for completions in tool files).

export const SKILL_TEMPLATE = (name: string): string => `---
name: ${name}
description: One line saying what these instructions are for
when: word, another word, a short phrase
---

# ${name}

Write here what the agent should know or do when this comes up: the steps,
the conventions, the things to check, the mistakes to avoid.

The words after "when:" decide when this is loaded: if your message contains
one of them, these instructions join the conversation. Put "always: true" in
the header instead to have them in every session.
`

export const SPEC_TEMPLATE = (project: string): string => `# ${project}

What this project is and who it is for, in a few sentences.

## What it does

Describe each thing the project should do, one section per feature. Write it the
way you would explain it to a person: what happens, what the user sees, what
the rules are. Prism compares the agent's changes with these sections, and when
you edit a section it can change the code to match.

## Rules

Things that must always hold (for example: amounts are in pence, never floats).
`

export const TOOL_TEMPLATE = (name: string): string => `// A tool the agent can use. Save the file and it is available from the next message.
// Everything it can do goes through \`prism\`: this project's files, and (if listed in \`uses\`)
// shell commands and the internet. It has no other access to the computer.
/// <reference path="./prism-tools.d.ts" />

export default defineTool({
  name: '${name}',
  description: 'Counts the lines of a file in this project.',
  parameters: {
    path: { type: 'string', description: 'The file, relative to the project folder' }
  },
  // uses: ['shell'],     // allows prism.shell.run(command)
  // uses: ['network'],   // allows prism.fetch(url)
  // risk: 'none',        // never ask before running it (by default it asks in "Ask first" mode)
  async run({ path }, prism) {
    const text = await prism.fs.read(path)
    return \`\${path} has \${text.split('\\n').length} lines\`
  }
})
`

export const TOOL_TYPES = `// What a tool file in this folder can use. Prism keeps this file up to date; it is only here for your editor.

type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object'
interface ParamSpec {
  type: ParamType
  description?: string
  /** Leave the parameter out of the required ones. */
  optional?: boolean
  enum?: Array<string | number>
}
type ValueOf<P extends ParamSpec> = P['type'] extends 'string' ? string : P['type'] extends 'number' ? number : P['type'] extends 'boolean' ? boolean : P['type'] extends 'array' ? unknown[] : Record<string, unknown>
type ArgsOf<P extends Record<string, ParamSpec>> = { [K in keyof P]: ValueOf<P[K]> }

interface PrismTools {
  fs: {
    /** A text file's content. Paths are relative to the project folder and cannot leave it. */
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    list(path?: string): Promise<Array<{ name: string; path: string; kind: 'file' | 'dir' | 'symlink' | 'other'; size: number | null }>>
    exists(path: string): Promise<boolean>
    search(query: string, options?: { regex?: boolean; caseSensitive?: boolean; include?: string }): Promise<Array<{ path: string; line: number; text: string }>>
  }
  /** Needs uses: ['shell']. Runs in the project folder. */
  shell: { run(command: string, options?: { timeoutMs?: number }): Promise<{ code: number; output: string }> }
  /** Needs uses: ['network']. */
  fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; ok: boolean; text: string }>
  /** Lines shown to the agent after the result. */
  log(...values: unknown[]): void
}

declare function defineTool<P extends Record<string, ParamSpec>>(tool: {
  /** lower_case_with_underscores */
  name: string
  /** What it does, for the model deciding whether to use it. */
  description: string
  parameters?: P
  uses?: Array<'shell' | 'network'>
  /** 'none' never asks first. Default: 'low', or 'medium' when it uses the shell. */
  risk?: 'none' | 'low' | 'medium' | 'high'
  run(args: ArgsOf<P>, prism: PrismTools): unknown | Promise<unknown>
}): unknown
`

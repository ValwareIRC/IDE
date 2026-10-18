// What the agent remembers between sessions: one small markdown file per memory, with a name and a
// one-line description in front matter. Project memories live in the project (.prism/memory, so they
// travel with it and can be committed); personal ones live in Prism's data folder and apply everywhere.
// Every session sees the list of names and descriptions; the agent reads a memory in full when it is relevant.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Workspace } from '../fs/workspace'

export const PROJECT_MEMORY_DIR = '.prism/memory'

export type MemoryScope = 'project' | 'personal'

export interface Memory {
  name: string
  description: string
  body: string
  scope: MemoryScope
}

/** A memory's file name: lowercase words joined by dashes. */
export function memorySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function formatMemory(m: { name: string; description: string; body: string }): string {
  const one = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
  return `---\nname: ${one(m.name)}\ndescription: ${one(m.description)}\n---\n\n${m.body.trim()}\n`
}

export function parseMemory(text: string, scope: MemoryScope, fallbackName: string): Memory {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const head = m?.[1] ?? ''
  const field = (k: string): string => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim() ?? ''
  return { name: field('name') || fallbackName, description: field('description'), body: (m ? m[2]! : text).trim(), scope }
}

/** Where memories are kept, for one project and for the user. */
export class MemoryStore {
  constructor(
    private ws: Workspace,
    private personalDir: string
  ) {}

  async list(): Promise<Memory[]> {
    const out: Memory[] = []
    try {
      for (const e of await this.ws.list(PROJECT_MEMORY_DIR)) {
        if (e.kind !== 'file' || !e.name.endsWith('.md')) continue
        try {
          out.push(parseMemory((await this.ws.read(`${PROJECT_MEMORY_DIR}/${e.name}`)).content, 'project', e.name.slice(0, -3)))
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no project memories yet */
    }
    try {
      for (const f of await readdir(this.personalDir)) {
        if (!f.endsWith('.md')) continue
        try {
          out.push(parseMemory(await readFile(join(this.personalDir, f), 'utf8'), 'personal', f.slice(0, -3)))
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no personal memories yet */
    }
    return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
  }

  async find(name: string): Promise<Memory | null> {
    const slug = memorySlug(name)
    const all = await this.list()
    return all.find((m) => memorySlug(m.name) === slug) ?? null
  }

  /** Create or replace. Returns the path it was saved to, as the user would recognise it. */
  async save(m: { name: string; description: string; body: string; scope: MemoryScope }): Promise<string> {
    const slug = memorySlug(m.name)
    if (!slug) throw new Error('Give the memory a name.')
    const text = formatMemory(m)
    // a memory moved to the other scope leaves no copy behind
    const old = await this.find(m.name)
    if (old && old.scope !== m.scope) await this.remove(old.name)
    if (m.scope === 'project') {
      await this.ws.write(`${PROJECT_MEMORY_DIR}/${slug}.md`, text)
      return `${PROJECT_MEMORY_DIR}/${slug}.md`
    }
    await mkdir(this.personalDir, { recursive: true })
    await writeFile(join(this.personalDir, `${slug}.md`), text, 'utf8')
    return join(this.personalDir, `${slug}.md`)
  }

  async remove(name: string): Promise<boolean> {
    const m = await this.find(name)
    if (!m) return false
    const slug = memorySlug(m.name)
    if (m.scope === 'project') await this.ws.delete(`${PROJECT_MEMORY_DIR}/${slug}.md`)
    else await rm(join(this.personalDir, `${slug}.md`), { force: true })
    return true
  }
}

/** The list every session starts with. */
export function memoryIndex(all: Memory[]): string {
  if (!all.length) return ''
  const line = (m: Memory): string => `- ${m.name}: ${m.description || '(no description)'}`
  const project = all.filter((m) => m.scope === 'project')
  const personal = all.filter((m) => m.scope === 'personal')
  const parts = ['## What you remember', 'Saved in earlier sessions. Read one with memory_read when it is relevant before acting; fix or delete one that turns out to be wrong.']
  if (personal.length) parts.push(`About the user and how they like to work (every project):\n${personal.slice(0, 80).map(line).join('\n')}`)
  if (project.length) parts.push(`About this project:\n${project.slice(0, 80).map(line).join('\n')}`)
  return parts.join('\n\n')
}

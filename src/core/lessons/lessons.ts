// Lessons kept as files: a lesson is a Demo (renderer/src/demo/script.ts) saved as JSON, so
// one recorded by doing it, one the agent wrote and one written by hand are the same thing.
// A project's own lessons live in it (.prism/lessons, and travel with it); your own live in
// Prism's data folder and show in every project.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type LessonScope = 'project' | 'personal'

export interface LessonInfo {
  /** `<scope>:<file name>`, the handle the list and the editor use. */
  id: string
  scope: LessonScope
  title: string
  steps: number
  updatedAt: number
}

function dirOf(scope: LessonScope, root: string | null, userData: string): string | null {
  if (scope === 'project') return root ? join(root, '.prism', 'lessons') : null
  return join(userData, 'lessons')
}

function parseId(id: string): { scope: LessonScope; file: string } {
  const at = id.indexOf(':')
  const scope = id.slice(0, at) as LessonScope
  const file = id.slice(at + 1)
  if ((scope !== 'project' && scope !== 'personal') || !/^[\w.-]+\.json$/.test(file)) throw new Error('That is not a lesson.')
  return { scope, file }
}

/** A file name from a title: "How the tree works" becomes how-the-tree-works.json. */
function fileFor(title: string, dir: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lesson'
  let name = `${base}.json`
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.json`
  return name
}

export function listLessons(root: string | null, userData: string): LessonInfo[] {
  const out: LessonInfo[] = []
  for (const scope of ['project', 'personal'] as const) {
    const dir = dirOf(scope, root, userData)
    if (!dir || !existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { title?: unknown; steps?: unknown[] }
        out.push({ id: `${scope}:${f}`, scope, title: typeof d.title === 'string' ? d.title : f, steps: Array.isArray(d.steps) ? d.steps.length : 0, updatedAt: statSync(join(dir, f)).mtimeMs })
      } catch {
        /* not a lesson, or half written */
      }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function readLesson(id: string, root: string | null, userData: string): unknown {
  const { scope, file } = parseId(id)
  const dir = dirOf(scope, root, userData)
  if (!dir) throw new Error('Open a project to see its lessons.')
  return JSON.parse(readFileSync(join(dir, file), 'utf8'))
}

/** Saves a lesson: over `id` if given, else as a new file named after its title. Returns its id. */
export function writeLesson(scope: LessonScope, lesson: { title: string; steps: unknown[] }, root: string | null, userData: string, id?: string | null): string {
  if (!lesson || typeof lesson.title !== 'string' || !Array.isArray(lesson.steps)) throw new Error('A lesson needs a title and steps.')
  let file: string
  if (id) {
    const p = parseId(id)
    if (p.scope !== scope) throw new Error('A lesson cannot move between your lessons and the project\'s by saving.')
    file = p.file
  } else {
    const dir = dirOf(scope, root, userData)
    if (!dir) throw new Error('Open a project to keep a lesson in it.')
    mkdirSync(dir, { recursive: true })
    file = fileFor(lesson.title, dir)
  }
  const dir = dirOf(scope, root, userData)!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(lesson, null, 2) + '\n', 'utf8')
  return `${scope}:${file}`
}

export function removeLesson(id: string, root: string | null, userData: string): void {
  const { scope, file } = parseId(id)
  const dir = dirOf(scope, root, userData)
  if (dir) rmSync(join(dir, file), { force: true })
}

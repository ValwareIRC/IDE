import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolve a user/model path against a root and throw if it escapes it. */
export function jail(root: string, p: unknown): string {
  const rel = typeof p === 'string' && p.trim() ? p.trim() : '.'
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
  const r = resolve(root)
  if (abs !== r && !abs.startsWith(r + sep)) throw new Error(`Path is outside the workspace: ${rel}`)
  return abs
}

export function toPosix(p: string): string {
  return p.split(sep).join('/')
}

export function relPosix(root: string, abs: string): string {
  const r = relative(resolve(root), abs)
  return r === '' ? '.' : toPosix(r)
}

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.cache',
  '.turbo',
  '.pnpm-store',
  'coverage',
  '.idea',
  '.vs',
  'Library',
  'Temp',
  'Logs',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  '.venv',
  'venv'
])

// the user's list (Settings, Files) replaces the built-in one once it is set
let hidden: Set<string> = IGNORED_DIRS

export function setHiddenDirs(names: string[]): void {
  hidden = new Set(names.map((n) => n.trim()).filter(Boolean))
  // git's own folder is never shown, whatever the list says
  hidden.add('.git')
}

export function hiddenDirs(): string[] {
  return [...hidden]
}

export function isIgnoredDir(name: string): boolean {
  return hidden.has(name)
}

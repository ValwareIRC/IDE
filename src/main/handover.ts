// A file or folder handed to Prism: "Open with Prism" in Explorer, a file dragged onto Prism.exe,
// or `Prism.exe <path>` typed somewhere. As in VS Code, a folder opens as a project in a window of
// its own, and a file opens as a tab: in the window whose project holds it, else in the Prism window
// used last, else (no window open) in a window with no project, just the file.
import { existsSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export interface Handed {
  /** A folder to open as a project, or the open project that holds the file; null for a file from outside every open project. */
  root: string | null
  /** The file to open: relative to root with forward slashes, or its full path when root is null. Null for a folder. */
  file: string | null
}

/** The path in a launch's arguments, if there is one. The program itself, and Electron's own app folder when run in development, are not paths handed over. */
export function handedPath(argv: string[], cwd: string, devApp: boolean): string | null {
  for (const a of argv.slice(devApp ? 2 : 1)) {
    if (!a || a.startsWith('-')) continue
    const p = resolve(cwd, a)
    if (existsSync(p)) return p
  }
  return null
}

/** Where a handed path opens, given the projects open now. */
export function placeHanded(path: string, openRoots: string[]): Handed | null {
  let isDir: boolean
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return null
  }
  if (isDir) return { root: path, file: null }
  const lower = path.toLowerCase()
  const holder = openRoots
    .filter((r) => lower.startsWith(r.toLowerCase().replace(/[\\/]+$/, '') + sep))
    .sort((a, b) => b.length - a.length)[0]
  if (holder) return { root: holder, file: relative(holder, path).split(sep).join('/') }
  return { root: null, file: path.split(sep).join('/') }
}

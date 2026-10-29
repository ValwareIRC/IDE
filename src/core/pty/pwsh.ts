// PowerShell 7, when it is installed. Windows ships only Windows PowerShell 5.1, which strips the
// double quotes inside anything it hands to another program: `node -e 'console.log("hi")'`
// reaches node as console.log(hi), and backtick escapes do not save it. PowerShell 7 hands
// arguments over intact, so Prism uses it for the agent's commands and new terminals when it can.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

let found: string | null | undefined

/** The path to pwsh.exe, or null when only Windows PowerShell 5.1 is here. Looked for once. */
export function findPwsh(): string | null {
  if (found !== undefined) return found
  found = null
  if (process.platform !== 'win32') return found
  const installed = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(installed)) return (found = installed)
  // installed as an app (winget, the Microsoft Store): a shortcut Node cannot see as a file, but can run
  const app = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  try {
    const r = spawnSync(app, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, timeout: 8000 })
    if (r.status === 0) found = app
  } catch {
    /* not there */
  }
  return found
}

// The fonts installed on this computer, for the theme editor's font lists.
import { execFile } from 'node:child_process'

let cache: Promise<string[]> | null = null

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

export function installedFonts(): Promise<string[]> {
  cache ??= (async () => {
    const out =
      process.platform === 'win32'
        ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'])
        : process.platform === 'darwin'
          ? await run('/usr/bin/atsutil', ['fonts', '-list'])
          : await run('fc-list', [':', 'family'])
    const names = out
      .split(/\r?\n/)
      .map((l) => l.split(',')[0]!.trim())
      .filter((l) => l && !/^(System Fonts|System Families):?$/i.test(l) && l.length < 80)
    return [...new Set(names)].sort((a, b) => a.localeCompare(b))
  })()
  return cache
}

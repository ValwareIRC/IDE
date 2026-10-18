// Where a workspace folder lives. The root path says it:
//
//   C:\dev\app                              this computer
//   \\wsl.localhost\Ubuntu\home\me\app      inside WSL; Windows can read the files through this path,
//                                           but commands (git, the shell, checks) must run inside WSL
//   ssh://me@host/home/me/app               on another computer; files and commands both go over SSH
//
// Pure string work, shared by main and renderer. Building the actual commands is core/remote/command.ts.

export type Place = { kind: 'local' } | { kind: 'wsl'; distro: string } | { kind: 'ssh'; host: string }

const WSL = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)([\\/].*)?$/i
const SSH = /^ssh:\/\/([^/]+)(\/.*)?$/i

export function placeOf(path: string | null | undefined): Place {
  const p = path ?? ''
  const w = WSL.exec(p)
  if (w) return { kind: 'wsl', distro: w[1]! }
  const s = SSH.exec(p)
  if (s) return { kind: 'ssh', host: s[1]! }
  return { kind: 'local' }
}

export function isRemote(path: string | null | undefined): boolean {
  return placeOf(path).kind !== 'local'
}

/** The path as the other side knows it: /home/me/app. A local path comes back unchanged. */
export function remotePath(path: string): string {
  const w = WSL.exec(path)
  if (w) return (w[2] ?? '').split('\\').join('/') || '/'
  const s = SSH.exec(path)
  if (s) return s[2] || '/'
  return path
}

export function wslRoot(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${`/${linuxPath}`.replace(/\/+/g, '/').replace(/\/$/, '').split('/').join('\\')}`
}

export function sshRoot(host: string, path: string): string {
  return `ssh://${host}${`/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')}`
}

/** A short label for the title bar and status bar; null for a folder on this computer. */
export function placeLabel(path: string | null | undefined): string | null {
  const p = placeOf(path)
  return p.kind === 'wsl' ? `WSL: ${p.distro}` : p.kind === 'ssh' ? `SSH: ${p.host}` : null
}

/** The folder's own name, whatever kind of path it is. */
export function folderName(path: string): string {
  return remotePath(path).split(/[\\/]/).filter(Boolean).pop() ?? path
}

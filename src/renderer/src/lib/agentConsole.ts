/** A tiny event bus feeding the "agent" console in the terminal panel. */

type Listener = (chunk: string) => void

const listeners = new Set<Listener>()
let buffer = ''
const MAX = 200_000

export function consoleWrite(chunk: string): void {
  buffer = (buffer + chunk).slice(-MAX)
  for (const l of listeners) l(chunk)
}

export function consoleSubscribe(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function consoleBuffer(): string {
  return buffer
}

export function consoleClear(): void {
  buffer = ''
  for (const l of listeners) l('\x1b[2J\x1b[H')
}

const CRLF = (s: string): string => s.replace(/\r?\n/g, '\r\n')

export const con = {
  banner(title: string, model: string): void {
    consoleWrite(`\r\n\x1b[38;5;117m◆ ${title}\x1b[0m \x1b[90m· ${model}\x1b[0m\r\n`)
  },
  command(cmd: string, agent?: string): void {
    consoleWrite(`\r\n\x1b[38;5;117m❯\x1b[0m ${agent ? `\x1b[35m[${agent}]\x1b[0m ` : ''}\x1b[1m${CRLF(cmd)}\x1b[0m\r\n`)
  },
  output(chunk: string): void {
    consoleWrite(CRLF(chunk))
  },
  exit(code: number | null, ms: number): void {
    const color = code === 0 ? '32' : '31'
    consoleWrite(`\x1b[90m[exit \x1b[${color}m${code ?? '?'}\x1b[90m · ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}]\x1b[0m\r\n`)
  },
  note(text: string): void {
    consoleWrite(`\x1b[90m${CRLF(text)}\x1b[0m\r\n`)
  },
  end(reason: string, ms: number): void {
    const icon = reason === 'completed' ? '\x1b[32m✓' : reason === 'aborted' ? '\x1b[33m■' : '\x1b[31m✕'
    consoleWrite(`${icon}\x1b[0m \x1b[90m${reason} · ${(ms / 1000).toFixed(1)}s\x1b[0m\r\n`)
  }
}

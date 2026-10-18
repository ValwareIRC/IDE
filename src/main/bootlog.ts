// A timestamped account of start-up on stderr, so a start that never shows its window can be
// compared line by line with one that does (an OS port once showed Prism's window only one
// start in four). It covers the first minute and a half; PRISM_BOOT_LOG=1 keeps it going.
const UNTIL_MS = 90_000
const always = !!process.env['PRISM_BOOT_LOG']

/** Milliseconds since this process started. */
export const sinceStart = (): number => Math.round(process.uptime() * 1000)

export function booting(): boolean {
  return always || sinceStart() < UNTIL_MS
}

export function bootLog(...parts: unknown[]): void {
  if (!booting()) return
  const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  try {
    process.stderr.write(`[boot +${sinceStart()}ms] ${text}\n`)
  } catch {
    /* no stderr (a Windows app started from its shortcut) */
  }
}

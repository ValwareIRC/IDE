// The page's start-up steps, sent to the main process's start-up log (main/bootlog.ts)
// through the console, which works before anything else is ready.
const t0 = performance.now()

export function bootMark(step: string): void {
  console.info(`[boot] ${step} (+${Math.round(performance.now() - t0)}ms in the page)`)
}

/**
 * A start-up request that may never answer on a system missing something it relies on:
 * says so after a few seconds, and gives up after `ms` with `fallback` (or an error).
 */
export function bootStep<T>(name: string, p: Promise<T>, ms: number, fallback?: () => T): Promise<T> {
  bootMark(`asking for ${name}`)
  const slow = setTimeout(() => bootMark(`still waiting for ${name}`), 3000)
  return new Promise<T>((resolve, reject) => {
    const limit = setTimeout(() => {
      bootMark(`gave up waiting for ${name} after ${ms / 1000} s`)
      if (fallback) resolve(fallback())
      else reject(new Error(`Prism could not get ${name} within ${ms / 1000} seconds.`))
    }, ms)
    p.then(
      (v) => {
        bootMark(`got ${name}`)
        resolve(v)
      },
      (e: unknown) => {
        bootMark(`could not get ${name}: ${e instanceof Error ? e.message : String(e)}`)
        reject(e)
      }
    ).finally(() => {
      clearTimeout(slow)
      clearTimeout(limit)
    })
  })
}

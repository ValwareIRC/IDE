/**
 * Server-sent events reader with a stall watchdog. Yields `data:` payloads.
 * Aborts only when the connection goes silent for `idleMs`, never while
 * chunks keep arriving (long generations are healthy; silence is not).
 */
export async function* readSse(
  res: Response,
  opts: { signal?: AbortSignal; idleMs?: number }
): AsyncGenerator<string, void, void> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const idleMs = opts.idleMs ?? 180_000
  let buf = ''
  let dataLines: string[] = []

  const readWithIdle = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    let timer: NodeJS.Timeout | undefined
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StallError(idleMs)), idleMs)
    })
    try {
      return await Promise.race([reader.read(), stall])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    while (true) {
      if (opts.signal?.aborted) throw new Error('aborted')
      const { done, value } = await readWithIdle()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === '') {
          if (dataLines.length) {
            const payload = dataLines.join('\n')
            dataLines = []
            yield payload
          }
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length) yield dataLines.join('\n')
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* closed */
    }
  }
}

export class StallError extends Error {
  constructor(idleMs: number) {
    super(`No data from the model for ${Math.round(idleMs / 1000)}s. The connection stalled.`)
    this.name = 'StallError'
  }
}

export async function errorBody(res: Response): Promise<string> {
  try {
    const t = await res.text()
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string }
      if (typeof j.error === 'string') return j.error
      if (j.error?.message) return j.error.message
      if (j.message) return j.message
    } catch {
      /* not json */
    }
    return t
  } catch {
    return ''
  }
}

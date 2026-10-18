import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Cipher {
  available: boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

/** API keys at rest, encrypted with the OS keychain (DPAPI / Keychain / libsecret). */
export class Vault {
  private file: string
  private cipher: Cipher
  private data: Record<string, string> = {}

  constructor(file: string, cipher: Cipher) {
    this.file = file
    this.cipher = cipher
    try {
      if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      this.data = {}
    }
  }

  get encryptionAvailable(): boolean {
    return this.cipher.available
  }

  set(id: string, secret: string): void {
    const blob = this.cipher.available ? this.cipher.encrypt(secret) : Buffer.from(secret, 'utf8')
    this.data[id] = `${this.cipher.available ? 'enc' : 'plain'}:${blob.toString('base64')}`
    this.flush()
  }

  /** Store an already-encoded record ("enc:…" / "plain:…") as-is. */
  setRaw(id: string, record: string): void {
    if (!/^(enc|plain):/.test(record)) return
    this.data[id] = record
    this.flush()
  }

  get(id: string): string | null {
    const rec = this.data[id]
    if (!rec) return null
    const i = rec.indexOf(':')
    const tag = rec.slice(0, i)
    const buf = Buffer.from(rec.slice(i + 1), 'base64')
    try {
      return tag === 'enc' ? this.cipher.decrypt(buf) : buf.toString('utf8')
    } catch {
      return null
    }
  }

  has(id: string): boolean {
    return id in this.data
  }

  delete(id: string): void {
    delete this.data[id]
    this.flush()
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
  }
}

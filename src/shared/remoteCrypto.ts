// The encrypted channel between Prism and a remote client (the phone app). The same over a direct connection
// and through a relay: the relay only ever passes these bytes along.
//
// Pairing (once): Prism shows a one-time code (as a QR code, or to type). The client sends its long-term
// public key with proof it knows the code; Prism answers with its own public key and the same kind of proof.
// Each then keeps the other's key. Connecting: both send a fresh key and a random nonce; the channel keys come
// from both the fresh keys and the long-term ones (so a stolen long-term key does not open old traffic), and
// every message is sealed with ChaCha20-Poly1305 under a counter, so nothing can be read, changed or replayed.
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'

export const PROTOCOL = 1

export interface KeyPair {
  secret: Uint8Array
  public: Uint8Array
}

export function newKeyPair(): KeyPair {
  const secret = x25519.utils.randomSecretKey()
  return { secret, public: x25519.getPublicKey(secret) }
}

export function publicOf(secret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secret)
}

export const random = (n: number): Uint8Array => randomBytes(n)

// ---------------------------------------------------------------- text forms

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** URL-safe base64 without padding (works the same in Node and in a browser). */
export function b64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '') + (i + 2 < bytes.length ? B64[n & 63]! : '')
  }
  return out
}

export function unb64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((j) => (i + j < clean.length ? B64.indexOf(clean[i + j]!) : 0))
    if (v.some((x) => x < 0)) throw new Error('Not base64')
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** A pairing code people can type: 20 characters in groups of five (100 bits), no 0/O or 1/I to confuse. */
export function newPairCode(): string {
  const bytes = randomBytes(20)
  const chars = [...bytes].map((b) => BASE32[b % 32]!).join('')
  return chars.match(/.{5}/g)!.join('-')
}

export const normaliseCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** A short fingerprint of a public key, for people to compare. */
export function fingerprint(pub: Uint8Array): string {
  const h = sha256(pub)
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join(' ')
}

/** Prism's address on a relay: from its public key, so nobody else can claim it. */
export const hostIdOf = (pub: Uint8Array): string => b64(sha256(pub).slice(0, 12))

// ---------------------------------------------------------------- proofs and keys

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Proof of knowing the pairing code, bound to the keys and nonces it came with. */
export function codeProof(code: string, label: string, ...parts: Uint8Array[]): Uint8Array {
  return hmac(sha256, utf8ToBytes(normaliseCode(code)), cat(utf8ToBytes(label), ...parts))
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}

export interface Keys {
  send: Uint8Array
  recv: Uint8Array
}

/** The two channel keys, from the fresh keys and the long-term ones of both sides. */
export function channelKeys(role: 'host' | 'client', mine: { eph: Uint8Array; static: Uint8Array }, theirs: { eph: Uint8Array; static: Uint8Array }, clientNonce: Uint8Array, hostNonce: Uint8Array): Keys {
  const ikm = cat(x25519.getSharedSecret(mine.eph, theirs.eph), x25519.getSharedSecret(mine.static, theirs.static))
  const okm = hkdf(sha256, ikm, cat(clientNonce, hostNonce), utf8ToBytes('prism-remote-1'), 64)
  const toHost = okm.slice(0, 32)
  const toClient = okm.slice(32, 64)
  return role === 'host' ? { send: toClient, recv: toHost } : { send: toHost, recv: toClient }
}

// ---------------------------------------------------------------- messages

/** JSON that carries bytes (attachments, recordings) as {__u8: base64}. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? { __u8: b64(v) } : v))
}

export function decode(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => (v && typeof v === 'object' && typeof (v as { __u8?: unknown }).__u8 === 'string' ? unb64((v as { __u8: string }).__u8) : v))
}

/** One direction of a channel: each message is sealed under the next counter, and must arrive in order. */
export class Channel {
  private out = 0n
  private in = 0n
  private keys: Keys
  constructor(keys: Keys) {
    this.keys = keys
  }

  seal(value: unknown): Uint8Array {
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, this.out++)
    const box = chacha20poly1305(this.keys.send, nonce).encrypt(utf8ToBytes(encode(value)))
    return cat(nonce.slice(4), box)
  }

  open(frame: Uint8Array): unknown {
    const counter = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0)
    if (counter !== this.in) throw new Error('A message was replayed, lost or reordered')
    this.in++
    const nonce = new Uint8Array(12)
    nonce.set(frame.slice(0, 8), 4)
    const plain = chacha20poly1305(this.keys.recv, nonce).decrypt(frame.slice(8))
    return decode(new TextDecoder().decode(plain))
  }
}

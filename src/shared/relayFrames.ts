// How Prism and a relay talk: one connection from Prism carries every client's traffic, each frame tagged with
// the client connection it belongs to. Clients talk to the relay exactly as they would to Prism directly.
export const RELAY_OPEN = 1
export const RELAY_TEXT = 2
export const RELAY_BINARY = 3
export const RELAY_CLOSE = 4

export function relayFrame(kind: number, conn: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = kind
  new DataView(out.buffer).setUint32(1, conn)
  out.set(payload, 5)
  return out
}

export function readRelayFrame(frame: Uint8Array): { kind: number; conn: number; payload: Uint8Array } {
  return { kind: frame[0]!, conn: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1), payload: frame.subarray(5) }
}

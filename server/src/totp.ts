import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Authenticator-app codes (RFC 6238, the standard Google Authenticator / Microsoft Authenticator use).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('Invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(randomBytes(20))

export function totpCode(secret: string, timeMs: number, digits = 6, step = 30): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(bin).padStart(digits, '0')
}

/** Accepts the current code or one step either side, to allow for phone clock drift. */
export function verifyTotp(secret: string, code: string, timeMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false
  return [-1, 0, 1].some((w) => {
    const expected = Buffer.from(totpCode(secret, timeMs + w * 30_000))
    return timingSafeEqual(expected, Buffer.from(code))
  })
}

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent('Sathya HMS:' + account)}?secret=${secret}&issuer=${encodeURIComponent('Sathya HMS')}`

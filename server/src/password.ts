import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Db } from './db'

// Passwords are kept as scrypt hashes: `scrypt$<salt>$<hash>`, both base64url.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const KEY_LEN = 32

export async function hashPassword(pw: string) {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(pw, salt, KEY_LEN)).toString('base64url')}`
}

export async function verifyPassword(pw: string, stored: string | null) {
  const [kind, salt, hash] = (stored ?? '').split('$')
  // Unknown logins still cost one hash, so the answer time doesn't tell which emails exist.
  const got = await scrypt(pw, salt ? Buffer.from(salt, 'base64url') : Buffer.alloc(16), KEY_LEN)
  if (kind !== 'scrypt' || !hash) return false
  const want = Buffer.from(hash, 'base64url')
  return want.length === got.length && timingSafeEqual(want, got)
}

export const normaliseEmail = (e: unknown) => String(e ?? '').trim().toLowerCase()
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254

/** Why a new password won't do, or null if it will. */
export function weakPassword(pw: string, email?: string | null) {
  if (pw.length < 8) return 'Use at least 8 characters.'
  if (pw.length > 200) return 'That password is too long.'
  const name = email?.split('@')[0] ?? ''
  if (name.length >= 4 && pw.toLowerCase().includes(name)) return 'Don\'t use your email name in the password.'
  if (/^(.)\1+$/.test(pw) || /^(password|12345678|sathya)/i.test(pw)) return 'That password is too easy to guess.'
  return null
}

/** A temporary password to hand to someone, e.g. "kite-4827-moss": easy to read out, changed at first sign-in. */
export function tempPassword() {
  const words = ['amber', 'brook', 'cedar', 'delta', 'ember', 'fern', 'grove', 'harbor', 'iris', 'jade', 'kite', 'lotus', 'maple', 'nova', 'opal', 'pearl', 'quill', 'river', 'sage', 'tulip', 'vale', 'willow', 'zest', 'moss']
  return `${words[randomInt(words.length)]}-${String(randomInt(10000)).padStart(4, '0')}-${words[randomInt(words.length)]}`
}

/**
 * Gives the MD's login its email and first password from the environment (MD_EMAIL, MD_PASSWORD).
 * The password is set only while the login has none, or when `reset` is on (MD_PASSWORD_RESET=yes),
 * and must be changed at the first sign-in so it doesn't stay in the hosting settings.
 */
export async function ensureMdLogin(db: Db, opts: { email?: string; password?: string; reset?: boolean }) {
  const email = opts.email ? normaliseEmail(opts.email) : ''
  if (email && validEmail(email)) await db.query(`update app_user set email = $1 where id = 'u-md' and (email is null or $2)`, [email, !!opts.reset])
  if (!opts.password) return
  const [u] = await db.query<{ password_hash: string | null }>(`select password_hash from app_user where id = 'u-md'`)
  if (!u || (u.password_hash && !opts.reset)) return
  await db.query(`update app_user set password_hash = $1, must_change_password = true, failed_logins = 0, locked_until = null, active = true where id = 'u-md'`,
    [await hashPassword(opts.password)])
  if (u.password_hash) await db.query(`update user_session set revoked_at = now() where user_id = 'u-md' and revoked_at is null`)
}

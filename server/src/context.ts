import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { TaxConfig } from '@sathya/tax'
import type { Actor } from '@sathya/audit'
import type { Db } from './db'

// Everything a route needs, passed in once so tests can swap the clock and the SMS sender.

export interface SmsSender { sendOtp(mobile: string, code: string): Promise<void> }

export interface RolesConfig {
  sign_in: {
    second_factor_required: string[]
    device_registration_required: string[]
    session_timeout_minutes: { god_mode: number; back_office: number; operations: number }
  }
  roles: Record<string, { god_mode?: boolean; permissions?: string[]; limits?: unknown }>
  god_mode_alerts?: { id: string; value?: number }[]
}

export interface Ctx {
  db: Db
  tax: TaxConfig
  roles: RolesConfig
  sms: SmsSender
  now: () => Date
}

export interface Caller extends Actor {
  roles: string[]
  godMode: boolean
  permissions: Set<string>
  sessionId: string
  scope: 'full' | 'enroll_2fa'
}

export const can = (c: Caller, permission: string) => c.permissions.has('*') || c.permissions.has(permission)

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message) }
}

export const loadRolesConfig = (): RolesConfig =>
  parse(readFileSync(fileURLToPath(new URL('../seed/roles-and-approvals.yaml', import.meta.url)), 'utf8'))

/** Development sender: prints the code to the server log. Production needs a DLT-registered SMS provider. */
export const consoleSms: SmsSender = {
  async sendOtp(mobile, code) {
    if (process.env.NODE_ENV === 'production') throw new Error('No SMS provider configured')
    console.log(`[dev] sign-in code for ${mobile}: ${code}`)
  },
}

/** Upserts roles and their permissions from the YAML file, so editing the file is enough. */
export async function syncRoles(db: Db, cfg: RolesConfig) {
  for (const [id, r] of Object.entries(cfg.roles)) {
    await db.query(
      `insert into role (id, name, god_mode, limits, permissions) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set god_mode = excluded.god_mode, limits = excluded.limits, permissions = excluded.permissions`,
      [id, id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), !!r.god_mode, JSON.stringify(r.limits ?? {}), r.permissions ?? []],
    )
  }
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// Typed view of config/tax-config.yaml: the file the CA reviews is the file the engine runs.

export interface Slab { max_value?: number; min_value?: number; rate: number; itc: boolean; effective_from: string }
export type Premises = 'specified' | 'other'

export interface TdsRule {
  code: string
  old_section: string
  rate: number | 'slab' | { individual_huf: number; others: number }
  threshold?: { single?: number; annual?: number; monthly?: number; annual_per_vendor?: number }
  applies_if_buyer_turnover_above?: number
  applies_to_resort?: boolean
}

export interface TaxConfig {
  meta: { entity_type: string; state_code: string }
  gst: {
    aato_band: 'under_5_crore' | '5_to_10_crore' | 'above_10_crore'
    accommodation: { sac: string; extra_charges_count_toward_value: boolean; slabs: Slab[] }
    restaurant: {
      sac: string
      specified_premises: { opted_in_by_declaration: boolean | null; status_by_fy: Record<string, Premises> }
      rates: { premises: Premises; rate: number; itc: boolean; effective_from: string }[]
    }
    accommodation_price_guard: { limit_per_unit_per_night: number; above_limit_requires: string; warn_text: string }
    e_invoice: { required_for_resort: boolean; report_within_days_if_aato_at_least: { aato: number; days: number } }
    reverse_charge: { service: string; rate: number; applies_when: 'always' | 'supplier_not_body_corporate' | 'supplier_unregistered' }[]
    other_services?: Record<string, { rate: number | null; sac?: string | null }>
    banquets?: {
      hall_and_lawn_rental: { sac: string | null; rate: number }
      event_catering: { sac: string }
      event_services?: { sac: string | null; rate: number }
    }
    credits_to_track: {
      gst_tds_by_government: { rate: number; contract_value_above: number }
      gst_tcs_by_ota: { rate: number }
    }
  }
  income_tax: {
    tds: TdsRule[]
    no_pan_rate: number
    deducted_from_resort: { by: string; nature: string; old_section: string; rate: number }[]
    tcs_paid_by_resort: { on: string; old_section: string; rate: number }[]
    controls: {
      block_cash_receipt_at_or_above: number
      warn_cash_expense_above: number
      msme_payment_days: { with_agreement: number; without_agreement: number }
    }
  }
  tn_vat: { rate_table: { class: string; rate: number | null }[] }
  liquor_controls: {
    legal_age: number; licensed_hours: { open: string | null; close: string | null }; dry_days: string[]
    purchase_only_from?: string[]; peg_sizes_ml?: number[]; variance_alert_percent?: number
  }
}

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config/tax-config.yaml', import.meta.url))

export function loadTaxConfig(path = DEFAULT_CONFIG_PATH): TaxConfig {
  return parse(readFileSync(path, 'utf8')) as TaxConfig
}

export class TaxConfigError extends Error {}

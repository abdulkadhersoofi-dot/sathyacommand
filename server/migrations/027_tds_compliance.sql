-- Phase 6.5: TDS compliance. Lower-deduction certificates (section 197) with their limit and validity; tax
-- deducted deposited by challan (ITNS 281) by the 7th of the next month (30 April for March), with interest
-- when late; quarterly statements (26Q) recorded as filed with their token number; advance tax.

create table ldc (
  id           text primary key,
  vendor_id    text not null references vendor,
  cert_no      text not null,
  section      text not null,
  rate         numeric(5,2) not null check (rate >= 0 and rate <= 30),
  limit_paise  bigint not null check (limit_paise > 0),
  valid_from   date not null,
  valid_to     date not null,
  created_by   text not null references app_user,
  created_at   timestamptz not null,
  unique (vendor_id, cert_no),
  check (valid_to >= valid_from)
);

-- A challan: TDS deposited for one month's deductions, or advance tax.
create table tax_challan (
  id               text primary key,
  kind             text not null check (kind in ('tds', 'advance_tax')),
  fy               text not null,
  month            text check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- TDS: the month the tax was deducted
  bsr_code         text not null check (bsr_code ~ '^[0-9]{7}$'),
  challan_no       text not null check (challan_no ~ '^[0-9]{5}$'),
  paid_on          date not null,
  tax_paise        bigint not null check (tax_paise >= 0),
  interest_paise   bigint not null default 0,
  late_fee_paise   bigint not null default 0,
  total_paise      bigint not null,
  bank_account_id  text references bank_account,
  voucher_id       text references voucher,
  by_user          text not null references app_user,
  at               timestamptz not null,
  unique (bsr_code, paid_on, challan_no)
);

alter table vendor_payment add column ldc_id text references ldc;
alter table tds_entry
  add column ldc_id      text references ldc,
  add column reason_code text check (reason_code in ('A', 'B', 'C')),   -- A lower deduction (197), C higher rate (no PAN)
  add column challan_id  text references tax_challan;

create table tds_return (
  id          text primary key,
  fy          text not null,
  quarter     int not null check (quarter between 1 and 4),
  form        text not null default '26Q' check (form in ('26Q')),
  token_no    text not null,
  filed_on    date not null,
  late_fee_paise bigint not null default 0,
  figures     jsonb not null,
  filed_by    text not null references app_user,
  filed_at    timestamptz not null,
  unique (fy, quarter, form)
);

-- The year's income tax as estimated, for the advance-tax instalments (15% by 15 June, 45% by 15 September,
-- 75% by 15 December, 100% by 15 March).
create table tax_estimate (
  fy                   text primary key,
  estimated_tax_paise  bigint not null check (estimated_tax_paise >= 0),
  note                 text,
  by_user              text not null references app_user,
  at                   timestamptz not null
);

-- The resort as deductor, for the quarterly statement.
alter table property add column tan text, add column tds_responsible text, add column tds_responsible_designation text;

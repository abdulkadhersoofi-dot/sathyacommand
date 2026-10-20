-- Phase 6.3: OTA reconciliation and tax credits. Bookings made through an online travel agent carry its
-- booking ID; what the guest paid the OTA is owed by the OTA, which pays out the net after its commission,
-- GST on that commission, GST TCS (section 52) and income-tax TDS (194-O). Every tax deducted or collected
-- from the resort (by OTAs, companies and TASMAC) is a credit to claim, followed until Form 26AS shows it.

alter table reservation add column ota_ref text;
create index reservation_ota_ref on reservation (ota_ref) where ota_ref is not null;

alter table debtor
  add column tan                text,               -- the deductor's TAN, as Form 26AS lists it
  add column commission_percent numeric(5,2);       -- an OTA's agreed commission, to check its payouts

create table ota_payout (
  id                    text primary key,
  number                text not null unique,
  debtor_id             text not null references debtor,
  date                  date not null,
  reference             text,                       -- UTR of the payout
  bank_account_id       text references bank_account,
  commission_invoice    text,                       -- the OTA's tax invoice for its commission (input tax credit)
  gross_paise           bigint not null,            -- what guests paid the OTA for the bookings settled
  commission_paise      bigint not null default 0,
  commission_gst_paise  bigint not null default 0,
  gst_tcs_paise         bigint not null default 0,
  tds_paise             bigint not null default 0,
  other_paise           bigint not null default 0,  -- other deductions (penalties, promotions), to commission
  net_paise             bigint not null,
  checks                jsonb not null default '[]',
  voucher_id            text references voucher,
  by_user               text not null references app_user,
  at                    timestamptz not null
);

create table ota_payout_line (
  payout_id             text not null references ota_payout,
  line                  int not null,
  ota_ref               text,
  reservation_id        text references reservation,
  guest                 text,
  check_in              date,
  gross_paise           bigint not null,
  commission_paise      bigint not null default 0,
  commission_gst_paise  bigint not null default 0,
  gst_tcs_paise         bigint not null default 0,
  tds_paise             bigint not null default 0,
  primary key (payout_id, line)
);
create index ota_payout_line_res on ota_payout_line (reservation_id) where reservation_id is not null;

-- Form 26AS (or the AIS) as downloaded: one row per credit the government holds against the resort's PAN.
create table form26as_import (
  id           text primary key,
  fy           text not null,
  file_name    text,
  lines        int not null,
  imported_by  text not null references app_user,
  imported_at  timestamptz not null
);

create table form26as_line (
  id           text primary key,
  import_id    text not null references form26as_import,
  fy           text not null,
  kind         text not null check (kind in ('tds', 'tcs')),
  deductor     text not null,
  tan          text,
  section      text,
  date         date not null,
  quarter      int not null check (quarter between 1 and 4),
  paid_paise   bigint not null default 0,              -- amount paid / credited
  tax_paise    bigint not null,
  fingerprint  text not null unique
);

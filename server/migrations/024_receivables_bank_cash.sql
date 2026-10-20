-- Phase 6.2: receivables, banks and cash. Companies and agents billed on credit (the city ledger) with their
-- limits and terms; money received from them (with any TDS they deduct); the resort's bank accounts, their
-- statements imported and matched line by line to the books; card and UPI settlements with the fees taken;
-- cash banked and the petty cash float.

create table debtor (
  id                 text primary key,
  name               text not null,
  kind               text not null default 'company' check (kind in ('company', 'travel_agent', 'ota', 'government', 'other')),
  gstin              text,
  pan                text,
  address            text,
  city               text,
  contact_name       text,
  phone              text,
  email              text,
  credit_limit_paise bigint check (credit_limit_paise >= 0),   -- null: not set yet (no limit enforced)
  terms_days         int not null default 30 check (terms_days between 0 and 365),
  active             boolean not null default true,
  created_at         timestamptz not null
);
create unique index debtor_name on debtor (lower(name));
create unique index debtor_gstin on debtor (gstin) where gstin is not null;

alter table payment add column debtor_id text references debtor;
alter table fnb_payment add column debtor_id text references debtor;

create table bank_account (
  id            text primary key,
  name          text not null unique,
  bank          text,
  branch        text,
  account_no    text,                                -- shown masked
  ifsc          text,
  account_code  text not null unique references account,
  is_default    boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null
);
create unique index bank_account_one_default on bank_account (is_default) where is_default;

-- Money received from a company or agent on credit.
create table ar_receipt (
  id               text primary key,
  number           text not null unique,
  debtor_id        text not null references debtor,
  date             date not null,
  mode             text not null check (mode in ('bank', 'upi', 'cheque', 'cash')),
  reference        text,
  amount_paise     bigint not null check (amount_paise > 0),   -- settled against what they owe, TDS included
  tds_paise        bigint not null default 0 check (tds_paise >= 0),
  tds_section      text,
  bank_account_id  text references bank_account,
  note             text,
  voucher_id       text references voucher,
  received_by      text not null references app_user,
  received_at      timestamptz not null
);

create table bank_import (
  id               text primary key,
  bank_account_id  text not null references bank_account,
  file_name        text,
  lines            int not null,
  skipped          int not null default 0,
  imported_by      text not null references app_user,
  imported_at      timestamptz not null
);

create table bank_line (
  id               text primary key,
  seq              bigserial,                                   -- statement order
  bank_account_id  text not null references bank_account,
  import_id        text not null references bank_import,
  date             date not null,
  description      text not null,
  reference        text,
  amount_paise     bigint not null check (amount_paise <> 0),   -- into the account +, out −
  balance_paise    bigint,
  fingerprint      text not null,                               -- the same statement line imported twice is skipped
  status           text not null default 'open' check (status in ('open', 'matched', 'ignored')),
  voucher_id       text references voucher,
  voucher_line     int,
  note             text,
  decided_by       text references app_user,
  decided_at       timestamptz,
  unique (bank_account_id, fingerprint)
);
create unique index bank_line_one_match on bank_line (voucher_id, voucher_line) where voucher_id is not null;
create index bank_line_open on bank_line (bank_account_id, date) where status = 'open';

-- Cash banked, the petty cash float topped up, and small expenses paid from it.
create table cash_txn (
  id               text primary key,
  number           text not null unique,
  kind             text not null check (kind in ('deposit', 'petty_topup', 'petty_expense')),
  date             date not null,
  amount_paise     bigint not null check (amount_paise > 0),
  bank_account_id  text references bank_account,
  account_code     text references account,
  description      text,
  payee            text,
  reference        text,
  photo_id         text,
  voucher_id       text references voucher,
  by_user          text not null references app_user,
  at               timestamptz not null
);

alter table voucher drop constraint voucher_kind_check;
alter table voucher add constraint voucher_kind_check check (kind in ('sales', 'receipt', 'purchase', 'payment', 'contra', 'stock', 'journal', 'reversal'));

-- Phase 6.6: TN VAT returns recorded as filed; the fixed-asset register with depreciation (Companies Act in the
-- books, income-tax blocks for the return); department budgets; and logins that end on a date (the CA).

create table vat_return (
  id         text primary key,
  period     text not null unique check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ack_no     text not null,
  filed_on   date not null,
  figures    jsonb not null,
  filed_by   text not null references app_user,
  filed_at   timestamptz not null
);

create table fixed_asset (
  id                 text primary key,
  code               text not null unique,
  name               text not null,
  category           text not null check (category in ('building', 'plant', 'furniture', 'vehicle', 'computer', 'intangible')),
  account_code       text not null references account,
  dept               text,
  put_to_use         date not null,
  cost_paise         bigint not null check (cost_paise > 0),
  residual_percent   numeric(5,2) not null default 5,
  life_years         numeric(5,2) not null check (life_years > 0),   -- Companies Act, Schedule II
  opening_dep_paise  bigint not null default 0,                     -- depreciation before the books began (go-live assets)
  bill_id            text references purchase_bill,
  eng_asset_id       text references asset,                         -- the engineering register's record of it
  disposed_on        date,
  sale_paise         bigint,
  created_by         text not null references app_user,
  created_at         timestamptz not null
);

-- One depreciation run per month (the voucher it posted).
create table depreciation_run (
  month       text primary key check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount_paise bigint not null,
  voucher_id  text references voucher,
  run_by      text not null references app_user,
  run_at      timestamptz not null
);
create table depreciation_line (
  month        text not null references depreciation_run,
  asset_id     text not null references fixed_asset,
  amount_paise bigint not null,
  primary key (month, asset_id)
);

create table budget (
  fy            text not null,
  month         text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  dept          text not null,
  kind          text not null check (kind in ('revenue', 'cost')),
  amount_paise  bigint not null check (amount_paise >= 0),
  primary key (month, dept, kind)
);

alter table app_user add column access_until timestamptz;   -- set for the CA's time-limited access

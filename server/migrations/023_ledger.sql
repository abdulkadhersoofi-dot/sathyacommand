-- Phase 6.1: the general ledger. A chart of accounts for the hotel (USALI departments), double-entry vouchers
-- posted automatically from what the resort already records (bills, payments, purchases, stock) or entered by
-- accounts, and months locked once their books are closed. Vouchers are final: a mistake is put right by a
-- reversal, never by changing or deleting.

create table account (
  code        text primary key,
  name        text not null unique,
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  grp         text not null,                       -- the Schedule III / USALI heading it rolls up into
  dept        text,                                -- the department its income or cost belongs to
  system      boolean not null default false,      -- used by automatic postings: cannot be archived
  active      boolean not null default true,
  created_at  timestamptz not null
);

create table voucher (
  id           text primary key,
  number       text not null unique,
  kind         text not null check (kind in ('sales', 'receipt', 'purchase', 'payment', 'stock', 'journal', 'reversal')),
  date         date not null,                       -- the date it is posted on
  doc_date     date,                                -- the source document's own date, when the books were locked then
  narration    text not null,
  source_type  text,                                -- what it was posted from (null: entered by hand)
  source_id    text,
  reverses     text references voucher,
  total_paise  bigint not null,
  created_by   text references app_user,            -- null: posted by the system
  created_at   timestamptz not null
);
create unique index voucher_source on voucher (source_type, source_id) where source_type is not null;
create unique index voucher_one_reversal on voucher (reverses) where reverses is not null;
create index voucher_date on voucher (date);

create table voucher_line (
  voucher_id    text not null references voucher,
  line          int not null,
  account_code  text not null references account,
  dept          text,
  debit_paise   bigint not null default 0 check (debit_paise >= 0),
  credit_paise  bigint not null default 0 check (credit_paise >= 0),
  party_type    text check (party_type in ('vendor', 'company', 'guest', 'staff', 'ota')),
  party_id      text,
  party_name    text,
  ref           text,
  primary key (voucher_id, line),
  check ((debit_paise = 0) <> (credit_paise = 0))
);
create index voucher_line_account on voucher_line (account_code);
create index voucher_line_party on voucher_line (party_type, party_id) where party_id is not null;

create function voucher_guard() returns trigger language plpgsql as $$
begin
  raise exception 'vouchers cannot be changed or deleted; post a reversal';
end $$;
create trigger voucher_immutable before update or delete on voucher for each row execute function voucher_guard();
create trigger voucher_line_immutable before update or delete on voucher_line for each row execute function voucher_guard();

-- A month whose books are closed: nothing more is posted into it (late documents land in the next open month).
create table period_lock (
  month      text primary key check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  note       text,
  locked_by  text not null references app_user,
  locked_at  timestamptz not null
);

-- Expense account for a service bill line, chosen by accounts (otherwise from the vendor's TDS category).
alter table bill_line add column account_code text references account;

-- Each store's stock sits in its own inventory account; the month close moves it to the month's closing value.
alter table store add column inventory_account text references account, add column change_account text references account;

-- Sources that came to nothing (every amount nil): marked so they are not looked at again.
create table voucher_skip (
  source_type  text not null,
  source_id    text not null,
  primary key (source_type, source_id)
);
create view posted_source as
  select source_type, source_id from voucher where source_type is not null
  union all select source_type, source_id from voucher_skip;

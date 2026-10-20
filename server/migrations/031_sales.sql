-- Phase 7.2: sales. Company accounts (the city-ledger accounts) with an account manager, contacts and
-- contracted room rates; follow-ups for accounts and events; room blocks for weddings and groups, held until
-- their cut-off; event vendors, with their bills tied to the event; and an event billed to a company's account.

alter table debtor
  add column owner_id  text references app_user,
  add column notes     text;

create table account_contact (
  id          text primary key,
  debtor_id   text not null references debtor,
  name        text not null,
  role        text,
  mobile      text,
  email       text,
  created_at  timestamptz not null
);
create index account_contact_debtor on account_contact (debtor_id);

-- A company's negotiated rate for a room type and meal plan, for a period.
create table contract_rate (
  id            text primary key,
  debtor_id     text not null references debtor,
  room_type_id  text not null references room_type,
  plan_code     text not null,
  valid_from    date not null,
  valid_to      date not null,
  rate_paise    bigint not null check (rate_paise > 0),
  set_by        text not null references app_user,
  created_at    timestamptz not null,
  check (valid_to >= valid_from)
);
create index contract_rate_lookup on contract_rate (debtor_id, room_type_id, plan_code, valid_from);

-- Rooms held for a wedding or a group: per room type, a number of rooms each night at an agreed rate, kept
-- off general sale until the cut-off; rooms not picked up by then are released.
create table room_block (
  id           text primary key,
  number       text not null unique,
  name         text not null,
  event_id     text references event,
  debtor_id    text references debtor,
  arrival      date not null,
  departure    date not null,
  cutoff       date not null,
  plan_code    text not null,
  status       text not null default 'open' check (status in ('open','released','cancelled')),
  released_at  timestamptz,
  created_by   text not null references app_user,
  created_at   timestamptz not null,
  check (departure > arrival),
  check (cutoff <= arrival)
);
create table room_block_line (
  block_id      text not null references room_block,
  room_type_id  text not null references room_type,
  rooms         int not null check (rooms > 0),
  rate_paise    bigint not null check (rate_paise > 0),
  primary key (block_id, room_type_id)
);

alter table reservation
  add column debtor_id  text references debtor,
  add column block_id   text references room_block;
create index reservation_block on reservation (block_id) where block_id is not null;

-- Calls, visits and meetings to make or made, for an account or an event.
create table sales_activity (
  id          text primary key,
  debtor_id   text references debtor,
  event_id    text references event,
  kind        text not null check (kind in ('call','visit','meeting','email','whatsapp','note')),
  subject     text not null,
  due_on      date,
  done_at     timestamptz,
  outcome     text,
  owner_id    text not null references app_user,
  created_by  text not null references app_user,
  created_at  timestamptz not null,
  check (debtor_id is not null or event_id is not null)
);
create index sales_activity_due on sales_activity (owner_id, due_on) where done_at is null;

-- Outside suppliers for an event (decorator, DJ, photographer, tent): what was agreed; their bills, entered in
-- payables with the event chosen, are paid there with TDS.
create table event_vendor (
  id            text primary key,
  event_id      text not null references event,
  vendor_id     text not null references vendor,
  service       text not null,
  agreed_paise  bigint not null default 0 check (agreed_paise >= 0),
  notes         text,
  created_at    timestamptz not null
);
alter table purchase_bill add column event_id text references event;

-- An event's bill moved to a company's credit account.
alter table event_payment drop constraint event_payment_method_check;
alter table event_payment add constraint event_payment_method_check check (method in ('cash','card','upi','bank','cheque','company'));
alter table event_payment add column debtor_id text references debtor;

-- An event for a company account.
alter table event add column debtor_id text references debtor;

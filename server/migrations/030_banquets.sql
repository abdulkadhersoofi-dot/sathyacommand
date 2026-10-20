-- Phase 7.1: banquets and events. The venue calendar, an event's functions, packages and quotes, the contract
-- with its advance schedule, payments (advances on GST receipt vouchers), the event order (BEO) that goes to
-- every department, the permissions checklist, the final bill and the client's feedback.

-- Venues are the hall, lawn, pavilion and ground spaces; each has a rental per function and a turnaround
-- (setting up and clearing) kept free between two bookings.
alter table space
  add column rental_paise        bigint check (rental_paise >= 0),
  add column turnaround_minutes  int not null default 180 check (turnaround_minutes >= 0);

create table venue_setup (
  space_id  text not null references space,
  style     text not null check (style in ('rounds','theatre','u_shape','classroom','cocktail','floating')),
  capacity  int not null check (capacity > 0),
  primary key (space_id, style)
);

-- Menus per plate, decor and other services sold with an event.
create table banquet_package (
  id           text primary key,
  name         text not null,
  kind         text not null check (kind in ('menu','decor','service')),
  price_paise  bigint not null check (price_paise >= 0),
  per          text not null check (per in ('plate','event')),
  veg          boolean,
  items        text[] not null default '{}',
  min_pax      int not null default 0 check (min_pax >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null
);

create table event (
  id                  text primary key,
  number              text not null unique,
  kind                text not null check (kind in ('wedding','reception','engagement','birthday','corporate','conference','social','other')),
  title               text not null,
  client_name         text not null,
  client_mobile       text,
  client_email        text,
  company             text,
  gstin               text,
  billing_address     text,
  source              text not null default 'walk_in' check (source in ('walk_in','phone','website','referral','planner','repeat','corporate')),
  owner_id            text references app_user,
  expected_pax        int check (expected_pax > 0),
  status              text not null default 'enquiry'
                      check (status in ('enquiry','quoted','hold','definite','billed','closed','lost','cancelled')),
  hold_until          date,
  site_visit_on       date,
  notes               text,
  instructions        jsonb not null default '{}',   -- per department: kitchen, service, housekeeping, engineering, security, front_office
  contract_signed_on  date,
  lost_reason         text,
  lost_to             text,
  cancel_reason       text,
  feedback_score      int check (feedback_score between 1 and 5),
  feedback_note       text,
  created_by          text not null references app_user,
  created_at          timestamptz not null,
  updated_at          timestamptz not null
);
create index event_status on event (status);

-- One event has one or more functions (mehendi on the lawn, muhurtham in the hall, reception at night).
create table event_function (
  id              text primary key,
  event_id        text not null references event,
  name            text not null,
  venue_id        text not null references space,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  setup_style     text not null default 'rounds' check (setup_style in ('rounds','theatre','u_shape','classroom','cocktail','floating')),
  expected_pax    int not null check (expected_pax > 0),
  guaranteed_pax  int check (guaranteed_pax > 0),
  actual_pax      int check (actual_pax >= 0),
  menu_id         text references banquet_package,
  rental_paise    bigint check (rental_paise >= 0),     -- null: the venue's rental
  created_at      timestamptz not null,
  check (ends_at > starts_at)
);
create index event_function_venue on event_function (venue_id, starts_at);
create index event_function_event on event_function (event_id);

-- Anything else sold with the event: decor, sound and lights, a cake, extra plates of a dish.
create table event_item (
  id           text primary key,
  event_id     text not null references event,
  function_id  text references event_function,
  package_id   text references banquet_package,
  description  text not null,
  qty          numeric(10,2) not null check (qty > 0),
  rate_paise   bigint not null check (rate_paise >= 0),
  gst_kind     text not null check (gst_kind in ('hall','catering','other')),
  created_at   timestamptz not null
);

-- A quote is a frozen copy of the lines and prices sent to the client; a new version supersedes the old.
create table event_quote (
  id                text primary key,
  event_id          text not null references event,
  version           int not null,
  lines             jsonb not null,
  discount_percent  numeric(5,2) not null default 0,
  taxable_paise     bigint not null,
  gst_paise         bigint not null,
  total_paise       bigint not null,
  status            text not null check (status in ('awaiting_approval','issued','accepted','superseded','rejected')),
  valid_until       date not null,
  created_by        text not null references app_user,
  created_at        timestamptz not null,
  accepted_at       timestamptz,
  unique (event_id, version)
);

-- The advance schedule agreed in the contract.
create table event_milestone (
  id            text primary key,
  event_id      text not null references event,
  seq           int not null default 0,
  label         text not null,
  due_on        date not null,
  amount_paise  bigint not null check (amount_paise > 0)
);

-- Money received (advances before the bill, the balance after it) and refunds (negative).
create table event_payment (
  id             text primary key,
  event_id       text not null references event,
  kind           text not null check (kind in ('advance','settlement','refund')),
  method         text not null check (method in ('cash','card','upi','bank','cheque')),
  amount_paise   bigint not null check (amount_paise <> 0),
  reference      text,
  voucher_id     text references tax_document,
  business_date  date not null,
  received_by    text not null references app_user,
  received_at    timestamptz not null
);
create index event_payment_event on event_payment (event_id);

-- Permissions each event needs: music licence, police, fire safety, liquor.
create table event_check (
  event_id    text not null references event,
  item        text not null,
  status      text not null default 'pending' check (status in ('pending','applied','received','not_needed')),
  ref         text,
  updated_by  text references app_user,
  updated_at  timestamptz,
  primary key (event_id, item)
);

-- The event order: each revision is a frozen copy sent to every department, which acknowledges it.
create table event_beo (
  event_id   text not null references event,
  revision   int not null,
  content    jsonb not null,
  issued_by  text not null references app_user,
  issued_at  timestamptz not null,
  primary key (event_id, revision)
);
create table beo_ack (
  event_id  text not null,
  revision  int not null,
  dept      text not null,
  acked_by  text not null references app_user,
  acked_at  timestamptz not null,
  primary key (event_id, revision, dept),
  foreign key (event_id, revision) references event_beo
);

alter table tax_document add column event_id text references event;
create index tax_document_event on tax_document (event_id);

-- An event is a party in the books (the banquet ledger), like a guest or a company.
alter table voucher_line drop constraint voucher_line_party_type_check;
alter table voucher_line add constraint voucher_line_party_type_check check (party_type in ('vendor', 'company', 'guest', 'staff', 'ota', 'event'));

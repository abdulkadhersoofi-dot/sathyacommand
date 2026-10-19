-- Front office: guests, reservations, room nights, folios (guest bills), payments, cashier shifts, night audit.
-- Bills are never edited: corrections are reversal lines. Money in paise.

alter table property add column business_date date;
update property set business_date = current_date where business_date is null;
alter table property alter column business_date set not null;

create table guest (
  id            text primary key,
  name          text not null,
  mobile        text,
  email         text,
  nationality   text not null default 'IN',      -- ISO country code; anything else triggers Form C
  id_type       text,
  id_last4      text,                            -- only the last 4 characters of an ID number are kept
  company       text,
  gstin         text,
  vip           boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);
create index guest_mobile on guest (mobile);

create table reservation (
  id               text primary key,
  property_id      text not null references property,
  guest_id         text not null references guest,
  status           text not null check (status in ('confirmed','in_house','checked_out','cancelled','no_show')),
  room_type_id     text not null references room_type,
  space_id         text references space,
  rate_plan_code   text not null,
  arrival          date not null,
  departure        date not null,
  adults           int not null default 1 check (adults >= 1),
  children         int not null default 0 check (children >= 0),
  source           text not null default 'direct',
  eta              text,
  bill_to_company  text,
  bill_to_gstin    text,
  requests         text,
  checked_in_at    timestamptz,
  checked_out_at   timestamptz,
  cancel_reason    text,
  created_by       text not null references app_user,
  created_at       timestamptz not null default now(),
  check (departure > arrival)
);
create index reservation_dates on reservation (arrival, departure);
create index reservation_status on reservation (status);

-- One row per booked night, with the price fixed at booking time. A room can hold only
-- one live night per date: the database refuses double-booking even under a race.
create table room_night (
  reservation_id   text not null references reservation,
  night            date not null,
  room_type_id     text not null references room_type,
  space_id         text references space,
  amount_paise     bigint not null check (amount_paise >= 0),
  extras_paise     bigint not null default 0 check (extras_paise >= 0),
  released         boolean not null default false,
  posted_line_id   text,
  primary key (reservation_id, night)
);
create unique index room_night_one_per_room on room_night (space_id, night) where space_id is not null and not released;
create index room_night_type_date on room_night (room_type_id, night) where not released;

create table folio (
  id              text primary key,
  reservation_id  text not null references reservation,
  label           text not null default 'Guest',
  bill_to         text not null,
  gstin           text,
  status          text not null default 'open' check (status in ('open','closed')),
  created_at      timestamptz not null default now()
);

create table folio_line (
  id             text primary key,
  folio_id       text not null references folio,
  business_date  date not null,
  posted_at      timestamptz not null,
  kind           text not null check (kind in ('room','extra_bed','laundry','misc','payment','refund','reversal')),
  description    text not null,
  sac            text,
  gst_rate       numeric(5,2),
  taxable_paise  bigint not null default 0,
  cgst_paise     bigint not null default 0,
  sgst_paise     bigint not null default 0,
  amount_paise   bigint not null,              -- charges positive, payments negative
  reverses       text references folio_line,
  posted_by      text not null references app_user,
  ref            text
);
create index folio_line_folio on folio_line (folio_id);
create unique index folio_line_one_reversal on folio_line (reverses) where reverses is not null;

create table cashier_shift (
  id               text primary key,
  user_id          text not null references app_user,
  business_date    date not null,
  opened_at        timestamptz not null,
  opening_float    bigint not null,
  closed_at        timestamptz,
  counted_cash     bigint,
  expected_cash    bigint,
  variance         bigint,
  denominations    jsonb
);
create unique index cashier_one_open_shift on cashier_shift (user_id) where closed_at is null;

create table payment (
  id             text primary key,
  folio_id       text not null references folio,
  line_id        text not null references folio_line,
  method         text not null check (method in ('cash','card','upi','bank','company','ota')),
  amount_paise   bigint not null,               -- positive received, negative refunded
  reference      text,
  shift_id       text references cashier_shift,
  received_by    text not null references app_user,
  at             timestamptz not null
);

create table form_c (
  reservation_id  text primary key references reservation,
  due_at          timestamptz not null,
  submitted_at    timestamptz,
  submitted_by    text references app_user,
  reference       text
);

create table night_audit (
  business_date  date primary key,
  run_by         text not null references app_user,
  run_at         timestamptz not null,
  summary        jsonb not null
);

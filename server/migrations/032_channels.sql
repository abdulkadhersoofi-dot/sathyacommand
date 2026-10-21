-- Phase 7.3: guest channels. The resort's own booking page and online check-in (public, no login), payment
-- links, rate restrictions, and the link to a channel manager (availability and rates out, OTA bookings in).

-- Bookings and payments that arrive by themselves (website, channel manager, payment gateway) are made by
-- this login, which cannot sign in.
insert into app_user (id, name, active) values ('system', 'Online (website, channels, payments)', false) on conflict (id) do nothing;

-- Secrets the server makes for itself (e.g. for signing guests' links), kept across restarts.
create table app_secret (
  name        text primary key,
  value       text not null,
  created_at  timestamptz not null
);

-- Selling rules per room type and night: stop-sell, minimum stay, closed to arrival or departure.
create table rate_restriction (
  room_type_id  text not null references room_type,
  day           date not null,
  stop_sell     boolean not null default false,
  min_stay      int check (min_stay between 1 and 30),
  cta           boolean not null default false,
  ctd           boolean not null default false,
  set_by        text not null references app_user,
  set_at        timestamptz not null,
  primary key (room_type_id, day)
);

-- The channel manager's room and rate codes, mapped to the resort's room types and meal plans.
create table channel_map (
  channel       text not null,
  code          text not null,
  room_type_id  text not null references room_type,
  plan_code     text not null,
  primary key (channel, code)
);

-- Every booking message from the channel manager, applied or not (an OTA booking that cannot be placed is
-- kept and flagged, never lost).
create table channel_booking (
  id              text primary key,
  channel         text not null,
  ota_ref         text not null,
  action          text not null check (action in ('new','modify','cancel')),
  payload         jsonb not null,
  reservation_id  text references reservation,
  status          text not null check (status in ('applied','failed','duplicate','resolved')),
  error           text,
  received_at     timestamptz not null,
  resolved_by     text references app_user,
  resolved_at     timestamptz
);
create index channel_booking_ref on channel_booking (channel, ota_ref);

-- What a guest filled in before arrival. As at the desk, only the ID's type and last four characters are kept.
create table online_checkin (
  reservation_id  text primary key references reservation,
  eta             text,
  nationality     text,
  id_type         text,
  id_last4        text,
  address         text,
  purpose         text,
  preferences     text,
  company         text,
  gstin           text,
  submitted_at    timestamptz not null
);

-- Payment links sent to guests (deposit on a website booking, or any amount the desk asks for).
create table payment_link (
  id              text primary key,
  reservation_id  text not null references reservation,
  provider        text not null,
  provider_id     text,
  url             text,
  amount_paise    bigint not null check (amount_paise > 0),
  status          text not null check (status in ('created','paid','expired','cancelled')),
  payment_ref     text,
  created_at      timestamptz not null,
  paid_at         timestamptz
);
create index payment_link_reservation on payment_link (reservation_id);

-- A website booking waiting for its deposit: cancelled by itself if not paid by then.
alter table reservation add column pay_by timestamptz;

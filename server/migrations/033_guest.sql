-- Phase 7.4: the guest journey. Messages to guests (WhatsApp) at each step of a stay, requests from the QR
-- in every room, feedback after the stay with low scores flagged, and activities charged to the room.

-- Messages to guests, queued by the system at each step and sent by the WhatsApp provider when one is set
-- up; until then the desk sends them from its own WhatsApp with one tap.
create table guest_message (
  id              text primary key,
  reservation_id  text references reservation,
  mobile          text not null,
  template        text not null,
  body            text not null,
  status          text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  due_at          timestamptz not null,
  sent_at         timestamptz,
  sent_by         text references app_user,
  provider_ref    text,
  error           text,
  created_at      timestamptz not null,
  unique (reservation_id, template)
);
create index guest_message_queue on guest_message (status, due_at);

-- What a guest asks for from the QR in the room: housekeeping, food, a fault, anything else.
create table guest_request (
  id              text primary key,
  space_id        text not null references space,
  reservation_id  text references reservation,
  kind            text not null check (kind in ('housekeeping','food','maintenance','other')),
  items           jsonb not null default '[]',
  note            text,
  status          text not null default 'new' check (status in ('new','accepted','done','cancelled')),
  ticket_id       text references ticket,
  created_at      timestamptz not null,
  handled_by      text references app_user,
  handled_at      timestamptz,
  done_at         timestamptz
);
create index guest_request_open on guest_request (status, created_at);

-- Feedback after the stay (or from the room), with the manager's reply.
create table guest_feedback (
  id              text primary key,
  reservation_id  text references reservation,
  space_id        text references space,
  overall         int not null check (overall between 1 and 5),
  room            int check (room between 1 and 5),
  food            int check (food between 1 and 5),
  service         int check (service between 1 and 5),
  cleanliness     int check (cleanliness between 1 and 5),
  comment         text,
  created_at      timestamptz not null,
  reply           text,
  replied_by      text references app_user,
  replied_at      timestamptz,
  unique (reservation_id)
);

-- Things to do at the resort, and their bookings (charged to the room, or paid on the spot).
create table activity (
  id            text primary key,
  name          text not null,
  place         text references space,
  price_paise   bigint not null check (price_paise >= 0),
  per           text not null check (per in ('person','hour','session')),
  capacity      int check (capacity > 0),
  opens         text,
  closes        text,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null
);
create table activity_booking (
  id              text primary key,
  activity_id     text not null references activity,
  reservation_id  text references reservation,
  guest_name      text not null,
  day             date not null,
  at              text not null,
  qty             int not null check (qty > 0),
  amount_paise    bigint not null check (amount_paise >= 0),
  folio_line_id   text references folio_line,
  status          text not null default 'booked' check (status in ('booked','done','cancelled')),
  created_by      text not null references app_user,
  created_at      timestamptz not null
);
create index activity_booking_day on activity_booking (day, activity_id);

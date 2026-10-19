-- Phase 4.2: linen stock and laundry, guest laundry charged to the room, and public-area cleaning
-- rounds confirmed by scanning a QR code on site.

create table linen_item (
  id            text primary key,
  name          text not null unique,
  par_per_room  numeric(5,1) not null default 0,   -- pieces a room needs for one set
  par_sets      numeric(3,1) not null default 3,   -- sets to own: in the room, in the laundry, on the shelf
  active        boolean not null default true
);

create table linen_move (
  id             text primary key,
  item_id        text not null references linen_item,
  kind           text not null check (kind in ('purchase', 'send_laundry', 'receive_laundry', 'laundry_loss', 'discard', 'count_adjust')),
  qty            int not null,
  vendor         text,
  note           text,
  business_date  date not null,
  by_user        text not null references app_user,
  at             timestamptz not null
);
create index linen_move_item on linen_move (item_id);

create table laundry_item (
  id           text primary key,
  name         text not null,
  service      text not null check (service in ('wash_iron', 'dry_clean', 'press')),
  price_paise  bigint not null check (price_paise >= 0),
  active       boolean not null default true
);

create table laundry_order (
  id              text primary key,
  reservation_id  text not null references reservation,
  space_id        text not null references space,
  items           jsonb not null,
  express         boolean not null default false,
  total_paise     bigint not null,
  status          text not null default 'picked_up' check (status in ('picked_up', 'delivered', 'cancelled')),
  picked_by       text not null references app_user,
  picked_at       timestamptz not null,
  delivered_by    text references app_user,
  delivered_at    timestamptz,
  folio_line_id   text references folio_line
);

create table public_area (
  id              text primary key,
  name            text not null,
  space_id        text references space,
  code            text not null unique,      -- printed in the QR code on site
  rounds_per_day  int not null default 2 check (rounds_per_day between 1 and 48),
  active          boolean not null default true
);

create table area_round (
  id        text primary key,
  area_id   text not null references public_area,
  by_user   text not null references app_user,
  at        timestamptz not null,
  business_date date not null,
  note      text,
  photo_id  text references upload
);
create index area_round_day on area_round (area_id, business_date);

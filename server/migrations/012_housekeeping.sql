-- Phase 4.1: housekeeping. Each room's housekeeping state, the day's cleaning tasks with timers,
-- checklists, photos and inspection, minibar items, lost & found, and photo uploads.

create table room_hk (
  space_id       text primary key references space,
  status         text not null default 'inspected' check (status in
                   ('vacant_clean', 'inspected', 'vacant_dirty', 'occupied_clean', 'occupied_dirty', 'out_of_order', 'out_of_service')),
  dnd            boolean not null default false,
  dnd_since      timestamptz,
  section        text,
  ooo_reason     text,
  ooo_from       date,
  ooo_to         date,
  observed       text check (observed in ('vacant', 'occupied')),   -- what housekeeping last saw in the room
  observed_at    timestamptz,
  updated_at     timestamptz not null,
  updated_by     text
);

-- Photos (cleaning proof, faults, lost & found), kept small; resized on the phone before upload.
create table upload (
  id           text primary key,
  kind         text not null,
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        bytea not null,
  size         int not null check (size <= 1500000),
  uploaded_by  text not null references app_user,
  at           timestamptz not null
);

create table hk_task (
  id               text primary key,
  space_id         text references space,
  area             text,                                -- public area name when not a room
  business_date    date not null,
  kind             text not null check (kind in ('checkout', 'stayover', 'turndown', 'deep_clean', 'touch_up', 'public_area')),
  credits          numeric(4,1) not null,
  priority         int not null default 0,
  status           text not null default 'pending' check (status in ('pending', 'in_progress', 'cleaned', 'inspected', 'reclean', 'cancelled')),
  assigned_to      text references app_user,
  started_at       timestamptz,
  finished_at      timestamptz,
  checklist        jsonb not null default '[]',
  photos           text[] not null default '{}',
  notes            text,
  inspected_by     text references app_user,
  inspected_at     timestamptz,
  score            int check (score between 0 and 100),
  inspection_notes text,
  created_at       timestamptz not null
);
create index hk_task_day on hk_task (business_date, status);
create index hk_task_room on hk_task (space_id, status);
create unique index hk_task_one_active on hk_task (space_id, kind, business_date) where space_id is not null and status not in ('inspected', 'cancelled');

create table minibar_item (
  id           text primary key,
  name         text not null,
  price_paise  bigint not null check (price_paise >= 0),
  gst_rate     numeric(5,2) not null default 18,
  active       boolean not null default true
);

create table lost_found (
  id               text primary key,
  description      text not null,
  space_id         text references space,
  place            text,
  photo_id         text references upload,
  reservation_id   text references reservation,
  status           text not null default 'held' check (status in ('held', 'returned', 'disposed')),
  found_by         text not null references app_user,
  found_at         timestamptz not null,
  handed_to        text,
  handed_note      text,
  closed_by        text references app_user,
  closed_at        timestamptz
);

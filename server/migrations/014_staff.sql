-- Phase 4.3: the staff app. Shifts and rosters, geofenced attendance, on-duty location (GPS, Bluetooth
-- beacons), SOS, broadcasts, and each employee's consent to location sharing.

-- Resort boundary and how GPS maps onto the 3D model: the centre point, its position on the map (metres),
-- and the map's rotation from true north.
alter table property
  add column geo_lat          numeric(10,7),
  add column geo_lng          numeric(10,7),
  add column geo_radius_m     int not null default 400,
  add column geo_map_x        numeric(9,2) not null default 0,
  add column geo_map_z        numeric(9,2) not null default 0,
  add column geo_rotation     numeric(6,2) not null default 0,
  add column selfie_required  boolean not null default false;

create table shift (
  id      text primary key,
  name    text not null,
  starts  text not null,          -- 'HH:MM'
  ends    text not null,          -- may be past midnight
  active  boolean not null default true
);

create table roster (
  user_id   text not null references app_user,
  day       date not null,
  shift_id  text references shift,          -- null = weekly off
  primary key (user_id, day)
);

create table attendance (
  id               text primary key,
  user_id          text not null references app_user,
  day              date not null,
  shift_id         text references shift,
  clock_in_at      timestamptz not null,
  in_lat           numeric(10,7),
  in_lng           numeric(10,7),
  in_accuracy_m    int,
  selfie_id        text references upload,
  late_minutes     int not null default 0,
  clock_out_at     timestamptz,
  out_lat          numeric(10,7),
  out_lng          numeric(10,7),
  outside_since    timestamptz,                -- first ping outside the boundary in the current stretch
  outside_alerted  boolean not null default false
);
create unique index attendance_one_open on attendance (user_id) where clock_out_at is null;
create index attendance_day on attendance (day);

create table consent (
  user_id      text not null references app_user,
  kind         text not null,
  version      int not null,
  accepted_at  timestamptz not null,
  primary key (user_id, kind)
);

create table beacon (
  id        text primary key,               -- as the phone reports it (UUID:major:minor)
  name      text not null,
  space_id  text references space,
  floor     int,
  x         numeric(9,2),
  z         numeric(9,2)
);

create table location_ping (
  id        bigserial primary key,
  user_id   text not null references app_user,
  at        timestamptz not null,
  source    text not null check (source in ('gps', 'beacon', 'qr')),
  lat       numeric(10,7),
  lng       numeric(10,7),
  accuracy  int,
  x         numeric(9,2),
  z         numeric(9,2),
  inside    boolean,
  place     text
);
create index location_ping_user on location_ping (user_id, at desc);
create index location_ping_at on location_ping (at);

create table sos (
  id           text primary key,
  user_id      text not null references app_user,
  at           timestamptz not null,
  lat          numeric(10,7),
  lng          numeric(10,7),
  x            numeric(9,2),
  z            numeric(9,2),
  place        text,
  status       text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  ack_by       text references app_user,
  ack_at       timestamptz,
  resolved_by  text references app_user,
  resolved_at  timestamptz,
  note         text
);

create table broadcast (
  id         text primary key,
  from_user  text not null references app_user,
  at         timestamptz not null,
  text       text not null,
  roles      text[],                         -- null = everyone
  urgent     boolean not null default false
);

create table broadcast_read (
  broadcast_id  text not null references broadcast,
  user_id       text not null references app_user,
  read_at       timestamptz not null,
  primary key (broadcast_id, user_id)
);

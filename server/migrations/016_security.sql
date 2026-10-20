-- Phase 4.5: security. Gate register (vehicles, visitors, vendors, deliveries, guest vehicle tags and
-- parking), guard patrols by QR checkpoint with missed-checkpoint alerts, incidents, CCTV cameras on the
-- 3D map, the key register, and emergency mode with a roll-call of everyone on duty.

create table gate_entry (
  id              text primary key,
  kind            text not null check (kind in ('guest_vehicle', 'visitor', 'vendor', 'delivery', 'taxi', 'staff_vehicle')),
  name            text,
  mobile          text,
  vehicle_no      text,
  pax             int check (pax between 0 and 200),
  purpose         text,
  host            text,                          -- whom or what they came for
  reservation_id  text references reservation,
  tag_no          text,                          -- guest vehicle tag handed out at the gate
  parking         text,                          -- parking zone
  x               numeric(8,2),
  z               numeric(8,2),
  photo_id        text,
  in_at           timestamptz not null,
  in_by           text not null references app_user,
  out_at          timestamptz,
  out_by          text references app_user,
  note            text
);
create index gate_inside on gate_entry (in_at) where out_at is null;
create unique index gate_tag_inside on gate_entry (tag_no) where out_at is null and tag_no is not null;

create table checkpoint (
  id               text primary key,
  name             text not null,
  code             text not null unique,          -- printed in the QR label fixed at the spot
  space_id         text references space,
  x                numeric(8,2),
  z                numeric(8,2),
  missed_alert_at  timestamptz,                   -- last missed-checkpoint alert (one per gap)
  active           boolean not null default true
);

create table patrol_route (
  id              text primary key,
  name            text not null,
  checkpoint_ids  text[] not null,
  every_minutes   int not null check (every_minutes between 15 and 1440),
  starts          text not null,                  -- HH:MM; a route may run past midnight (22:00–06:00)
  ends            text not null,
  active          boolean not null default true
);

create table patrol_scan (
  id             text primary key,
  checkpoint_id  text not null references checkpoint,
  by_user        text not null references app_user,
  at             timestamptz not null,
  note           text,
  photo_id       text
);
create index patrol_scan_cp on patrol_scan (checkpoint_id, at desc);

create table incident (
  id               text primary key,
  kind             text not null check (kind in ('theft', 'injury', 'fire', 'fight', 'damage', 'trespass', 'guest_complaint', 'lost_child', 'other')),
  severity         text not null check (severity in ('low', 'medium', 'high', 'critical')),
  title            text not null,
  detail           text,
  space_id         text references space,
  x                numeric(8,2),
  z                numeric(8,2),
  photos           text[] not null default '{}',
  police_informed  boolean not null default false,
  reported_by      text not null references app_user,
  at               timestamptz not null,
  status           text not null default 'open' check (status in ('open', 'closed')),
  action_taken     text,
  closed_by        text references app_user,
  closed_at        timestamptz
);

create table camera (
  id         text primary key,
  name       text not null,
  space_id   text references space,
  x          numeric(8,2),
  z          numeric(8,2),
  view_url   text,                                -- the NVR's web or HLS view for this camera
  channel    text,                                -- NVR channel, for the guard's reference
  active     boolean not null default true
);

create table key_item (
  id      text primary key,
  label   text not null,
  kind    text not null default 'other' check (kind in ('master', 'room', 'store', 'plant', 'vehicle', 'other')),
  active  boolean not null default true
);

create table key_log (
  id           text primary key,
  key_id       text not null references key_item,
  issued_to    text not null,                      -- name (staff or contractor)
  user_id      text references app_user,
  issued_by    text not null references app_user,
  out_at       timestamptz not null,
  due_back     timestamptz,
  back_at      timestamptz,
  back_by      text references app_user,
  alerted      boolean not null default false,
  note         text
);
create unique index key_out on key_log (key_id) where back_at is null;

create table assembly_point (
  id      text primary key,
  name    text not null,
  x       numeric(8,2),
  z       numeric(8,2),
  active  boolean not null default true
);

create table emergency (
  id          text primary key,
  kind        text not null check (kind in ('fire', 'evacuation', 'lockdown', 'medical', 'other')),
  note        text,
  started_by  text not null references app_user,
  started_at  timestamptz not null,
  ended_by    text references app_user,
  ended_at    timestamptz,
  summary     text
);
create unique index emergency_one_active on emergency ((true)) where ended_at is null;

create table emergency_check (
  emergency_id  text not null references emergency,
  user_id       text not null references app_user,
  on_duty       boolean not null,                 -- clocked in when the emergency started
  status        text check (status in ('safe', 'need_help')),
  at            timestamptz,
  point_id      text references assembly_point,
  x             numeric(8,2),
  z             numeric(8,2),
  marked_by     text references app_user,         -- a warden marking someone they can see
  primary key (emergency_id, user_id)
);

-- Core property, inventory, rates, people and the God Mode audit log.
-- Money is stored in paise (bigint). Every table that money or guests touch is audited in audit_log.

create table property (
  id           text primary key,
  name         text not null,
  legal_name   text,
  entity_type  text not null,
  gstin        text,
  state_code   text not null default '33',
  created_at   timestamptz not null default now()
);

create table room_type (
  id               text primary key,
  property_id      text not null references property,
  name             text not null,
  base_rate_paise  bigint not null check (base_rate_paise >= 0),
  max_occupancy    int not null default 2,
  active           boolean not null default true
);

-- Every physical place in the resort: rooms, villas, suites, venues, outlets, stores.
-- twin_id links it to the object in the 3D model (null until drawn).
create table space (
  id            text primary key,
  property_id   text not null references property,
  kind          text not null check (kind in ('room','villa','suite','hall','lawn','pavilion','ground','restaurant',
                                               'kitchen','bar','reception','pool','store','service','office')),
  name          text not null,
  room_no       text,
  room_type_id  text references room_type,
  building      text,
  floor         int,
  capacity      int,
  twin_id       text,
  sellable      boolean not null default false,
  placeholder   boolean not null default false,
  active        boolean not null default true,
  unique (property_id, room_no)
);

create table rate_plan (
  id           text primary key,
  property_id  text not null references property,
  code         text not null,
  name         text not null,
  meal_plan    text not null check (meal_plan in ('EP','CP','MAP','AP')),
  active       boolean not null default true,
  unique (property_id, code)
);

create table rate (
  rate_plan_id  text not null references rate_plan,
  room_type_id  text not null references room_type,
  valid_from    date not null,
  valid_to      date not null,
  amount_paise  bigint not null check (amount_paise > 0),
  approved_by   text,
  primary key (rate_plan_id, room_type_id, valid_from),
  check (valid_to >= valid_from)
);

create table role (
  id        text primary key,
  name      text not null,
  god_mode  boolean not null default false,
  limits    jsonb not null default '{}'
);

create table app_user (
  id          text primary key,
  name        text not null,
  mobile      text unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table user_role (
  user_id  text not null references app_user,
  role_id  text not null references role,
  primary key (user_id, role_id)
);

create table device (
  id           text primary key,
  user_id      text not null references app_user,
  label        text,
  approved     boolean not null default false,
  approved_by  text,
  created_at   timestamptz not null default now()
);

-- God Mode log. `entry` holds the full record that was hashed; the other columns are for searching.
create table audit_log (
  seq           bigint primary key,
  at            timestamptz not null,
  actor_id      text not null,
  action        text not null,
  entity_type   text not null,
  entity_id     text not null,
  amount_paise  bigint,
  entry         jsonb not null,
  prev_hash     char(64) not null,
  hash          char(64) not null unique
);
create index audit_log_entity on audit_log (entity_type, entity_id);
create index audit_log_actor on audit_log (actor_id, at);
create index audit_log_action on audit_log (action, at);

-- Append-only, enforced by the database itself: no update, delete or truncate, whoever asks.
create function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_append_only();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_append_only();

-- Phase 4.4: engineering and maintenance. Assets pinned on the 3D map, planned maintenance, fault
-- tickets with response timers and escalation, the engineering spares store, utility meters, pool /
-- STP / fire safety logs, and owners and reminders for licences (the compliance calendar).

create table asset (
  id               text primary key,
  name             text not null,
  category         text not null check (category in ('ac', 'dg', 'pump', 'transformer', 'electrical', 'stp', 'pool', 'kitchen', 'cctv', 'lift', 'fire', 'plumbing', 'solar', 'laundry', 'vehicle', 'other')),
  space_id         text references space,
  x                numeric(8,2),                -- a pin on the 3D map (layout metres); else the space's centre
  z                numeric(8,2),
  make             text,
  model            text,
  serial           text,
  installed_on     date,
  warranty_until   date,
  amc_vendor       text,
  amc_until        date,
  amc_cost_paise   bigint check (amc_cost_paise >= 0),
  amc_reminded     int not null default 0,      -- last expiry reminder sent: days before (60, 30, 7) or -1 when overdue
  notes            text,
  active           boolean not null default true,
  created_at       timestamptz not null
);

create table pm_plan (
  id          text primary key,
  asset_id    text not null references asset,
  title       text not null,
  every_days  int not null check (every_days between 1 and 1095),
  checklist   jsonb not null default '[]',
  next_due    date not null,
  last_done   date,
  active      boolean not null default true
);

create table ticket (
  id            text primary key,
  kind          text not null check (kind in ('fault', 'pm')),
  title         text not null,
  detail        text,
  priority      text not null check (priority in ('urgent', 'high', 'normal', 'low')),
  status        text not null default 'open' check (status in ('open', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled')),
  asset_id      text references asset,
  space_id      text references space,
  x             numeric(8,2),
  z             numeric(8,2),
  pm_plan_id    text references pm_plan,
  checklist     jsonb not null default '[]',
  photos        text[] not null default '{}',
  reported_by   text references app_user,         -- null: raised by the system (planned maintenance)
  reported_at   timestamptz not null,
  assigned_to   text references app_user,
  responded_at  timestamptz,                    -- first taken, assigned or started
  respond_by    timestamptz not null,
  resolve_by    timestamptz not null,
  done_at       timestamptz,
  resolution    text,
  hold_reason   text,
  closed_by     text references app_user,
  closed_at     timestamptz,
  escalation    int not null default 0          -- 1: response overdue, 2: resolution overdue
);
create index ticket_open on ticket (status) where status in ('open', 'in_progress', 'on_hold');
create unique index ticket_pm_open on ticket (pm_plan_id) where pm_plan_id is not null and status in ('open', 'in_progress', 'on_hold');

create table spare (
  id             text primary key,
  name           text not null,
  unit           text not null default 'nos',
  reorder_level  numeric(10,2),
  cost_paise     numeric(14,2) not null default 0,   -- average cost per unit
  active         boolean not null default true
);

create table spare_move (
  id           text primary key,
  spare_id     text not null references spare,
  kind         text not null check (kind in ('receive', 'issue', 'return', 'adjust')),
  qty          numeric(10,2) not null,             -- signed: in +, out -
  value_paise  bigint not null,                    -- signed like qty
  ticket_id    text references ticket,
  vendor       text,
  note         text,
  by_user      text not null references app_user,
  at           timestamptz not null
);

create table meter (
  id          text primary key,
  name        text not null,
  kind        text not null check (kind in ('electricity', 'dg_hours', 'diesel', 'solar', 'water', 'lpg')),
  unit        text not null,
  cumulative  boolean not null default true,       -- a meter that counts up (the day's use is the difference) or a quantity per day
  rate_paise  bigint not null default 0,           -- cost per unit
  active      boolean not null default true
);

create table meter_reading (
  meter_id  text not null references meter,
  day       date not null,
  reading   numeric(14,2) not null,
  qty       numeric(14,2) not null,                -- the day's use
  reset     boolean not null default false,        -- meter replaced or rolled over
  note      text,
  by_user   text not null references app_user,
  at        timestamptz not null,
  primary key (meter_id, day)
);

create table ops_log (
  id             text primary key,
  kind           text not null check (kind in ('pool', 'stp', 'fire')),
  asset_id       text references asset,
  business_date  date not null,
  data           jsonb not null,
  ok             boolean not null,
  issues         text[] not null default '{}',
  ticket_id      text references ticket,          -- the fault raised when a check failed
  note           text,
  by_user        text not null references app_user,
  at             timestamptz not null
);
create index ops_log_kind on ops_log (kind, at desc);

alter table licence add column owner_id text references app_user;
alter table licence add column doc_ids text[] not null default '{}';
alter table licence add column reminded int not null default 0;

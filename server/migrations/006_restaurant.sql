-- Phase 3: restaurant, room service and bar. Outlets and menus, tables, orders, and KOT / BOT tickets
-- routed to kitchen and bar stations. Liquor is billed separately under TN VAT, so items carry a liquor class.

alter table property
  add column bar_open  text,          -- licensed hours 'HH:MM' from the FL-3 licence
  add column bar_close text,
  add column fssai_no  text;

-- Days the state closes liquor sales (national holidays, elections, notified days).
create table dry_day (
  day       date primary key,
  reason    text not null,
  added_by  text not null references app_user,
  added_at  timestamptz not null
);

create table station (
  id      text primary key,
  name    text not null,
  kind    text not null check (kind in ('kitchen', 'bar')),
  active  boolean not null default true
);

create table outlet (
  id             text primary key,
  name           text not null,
  kind           text not null check (kind in ('restaurant', 'room_service', 'bar', 'poolside', 'banquet')),
  space_id       text references space,
  serves_liquor  boolean not null default false,
  active         boolean not null default true
);

create table menu_category (
  id         text primary key,
  outlet_id  text not null references outlet,
  name       text not null,
  sort       int not null default 0,
  unique (outlet_id, name)
);

create table menu_item (
  id            text primary key,
  outlet_id     text not null references outlet,
  category_id   text references menu_category,
  code          text not null,
  name          text not null,
  name_ta       text,
  price_paise   bigint not null check (price_paise >= 0),
  liquor_class  text,                                  -- set for liquor: TN VAT bill, not GST
  station_id    text not null references station,
  diet          text not null default 'veg' check (diet in ('veg', 'egg', 'non_veg')),
  jain          boolean not null default false,
  allergens     text[] not null default '{}',
  available     boolean not null default true,         -- false = sold out for now ("86")
  active        boolean not null default true,
  placeholder   boolean not null default false,
  updated_at    timestamptz not null,
  unique (outlet_id, code)
);

create table dining_table (
  id         text primary key,
  outlet_id  text not null references outlet,
  label      text not null,
  seats      int not null default 4 check (seats between 1 and 40),
  section    text,
  active     boolean not null default true,
  unique (outlet_id, label)
);

-- Order, KOT and BOT numbers restart every business day and never skip.
create table fnb_counter (
  business_date  date not null,
  kind           text not null,
  next           int not null,
  primary key (business_date, kind)
);

create table fnb_order (
  id              text primary key,
  number          int not null,
  outlet_id       text not null references outlet,
  kind            text not null check (kind in ('dine_in', 'room_service', 'takeaway')),
  table_id        text references dining_table,
  reservation_id  text references reservation,
  covers          int not null default 1 check (covers between 1 and 200),
  status          text not null default 'open' check (status in ('open', 'billed', 'closed', 'cancelled')),
  business_date   date not null,
  opened_by       text not null references app_user,
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  note            text
);
create unique index fnb_order_number on fnb_order (business_date, number);
create unique index fnb_order_one_per_table on fnb_order (table_id) where table_id is not null and status in ('open', 'billed');
create index fnb_order_open on fnb_order (status) where status in ('open', 'billed');

create table kot (
  id             text primary key,
  number         int not null,
  kind           text not null check (kind in ('KOT', 'BOT')),
  order_id       text not null references fnb_order,
  station_id     text not null references station,
  business_date  date not null,
  status         text not null default 'new' check (status in ('new', 'cooking', 'ready', 'served')),
  prints         int not null default 1,
  created_by     text not null references app_user,
  created_at     timestamptz not null,
  ready_at       timestamptz,
  served_at      timestamptz
);
create unique index kot_number on kot (business_date, kind, number);
create index kot_active on kot (station_id, status) where status <> 'served';

create table order_item (
  id            text primary key,
  order_id      text not null references fnb_order,
  item_id       text not null references menu_item,
  name          text not null,                         -- name, price and routing as at the time of ordering
  price_paise   bigint not null,
  liquor_class  text,
  station_id    text not null references station,
  qty           int not null check (qty between 1 and 99),
  seat          int,
  course        int not null default 1,
  note          text,
  kot_id        text references kot,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'void')),
  added_by      text not null references app_user,
  added_at      timestamptz not null,
  void_reason   text,
  voided_by     text references app_user,
  voided_at     timestamptz
);
create index order_item_order on order_item (order_id);
create index order_item_kot on order_item (kot_id);

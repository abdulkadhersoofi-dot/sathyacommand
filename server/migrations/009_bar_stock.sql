-- Phase 3.4: bar stock. Brands with bottle sizes; menu items say which brand they pour and how much;
-- every movement (TASMAC purchase, sale, breakage, count adjustment) is a row, so the daily stock
-- register is a sum and nothing is ever overwritten.

create table liquor_brand (
  id            text primary key,
  name          text not null,
  liquor_class  text not null references liquor_class,
  bottle_ml     int not null check (bottle_ml between 50 and 5000),
  placeholder   boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null
);

alter table menu_item
  add column brand_id  text references liquor_brand,
  add column pour_ml   int check (pour_ml between 5 and 5000);

create table tasmac_purchase (
  id             text primary key,
  supplier       text not null,
  invoice_no     text not null,
  invoice_date   date not null,
  lines          jsonb not null,        -- brand, bottles, cost per bottle
  value_paise    bigint not null,
  vat_paise      bigint not null default 0,
  total_paise    bigint not null,
  business_date  date not null,
  received_by    text not null references app_user,
  received_at    timestamptz not null,
  unique (supplier, invoice_no)
);

create table bar_stock_move (
  id             text primary key,
  brand_id       text not null references liquor_brand,
  business_date  date not null,
  kind           text not null check (kind in ('purchase', 'sale', 'sale_reversal', 'breakage', 'count_adjust')),
  ml             int not null,          -- in positive, out negative
  ref            text,
  note           text,
  by_user        text not null references app_user,
  at             timestamptz not null
);
create index bar_stock_move_brand on bar_stock_move (brand_id, business_date);

create table bar_count (
  id                text primary key,
  business_date     date not null,
  lines             jsonb not null,     -- brand, book ml, counted ml, variance ml
  variance_percent  numeric(6,2) not null,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  counted_by        text not null references app_user,
  counted_at        timestamptz not null
);

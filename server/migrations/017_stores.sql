-- Phase 5.1: stores, the item master and the vendor master. Department stores that already keep their own
-- stock (kitchen ingredients, bar bottles, engineering spares, linen) are listed here with that ledger, so
-- goods received or issued into them land in the books those departments already use.

create table store (
  id        text primary key,
  name      text not null unique,
  kind      text not null check (kind in ('main', 'kitchen', 'bar', 'housekeeping', 'engineering', 'linen', 'other')),
  ledger    text not null default 'own' check (ledger in ('own', 'kitchen', 'bar', 'spares', 'linen')),
  space_id  text references space,
  active    boolean not null default true
);

create table item (
  id               text primary key,
  name             text not null unique,
  category         text not null check (category in ('food', 'beverage', 'liquor', 'housekeeping', 'amenities', 'linen', 'engineering', 'crockery', 'stationery', 'cleaning', 'other')),
  unit             text not null check (unit in ('g', 'ml', 'pcs', 'm', 'set', 'pair')),   -- stock is kept in this unit
  purchase_unit    text not null,                 -- what vendors sell: kg, litre, case of 24, box, …
  purchase_factor  numeric(12,3) not null check (purchase_factor > 0),   -- stock units in one purchase unit
  hsn              text check (hsn ~ '^\d{4,8}$'),
  gst_rate         numeric(5,2) check (gst_rate in (0, 0.25, 3, 5, 12, 18, 28, 40)),
  itc              text not null default 'full' check (itc in ('full', 'none', 'blocked')),  -- input tax credit
  perishable       boolean not null default false,
  shelf_life_days  int check (shelf_life_days > 0),
  ingredient_id    text unique references ingredient,
  spare_id         text unique references spare,
  linen_item_id    text unique references linen_item,
  brand_id         text unique references liquor_brand,
  default_store_id text references store,
  par_level        numeric(14,3),                 -- in stock units, in the default store
  reorder_qty      numeric(14,3),
  last_cost_paise  numeric(14,4),                 -- per stock unit, before GST
  barcode          text unique,
  active           boolean not null default true,
  created_at       timestamptz not null
);

create table vendor (
  id                 text primary key,
  name               text not null,
  legal_name         text,
  gstin              text unique,
  pan                text,
  state_code         text not null default '33',
  payee_type         text not null check (payee_type in ('individual', 'huf', 'company', 'firm', 'other')),
  tds_code           text,                       -- nature of payment in tax-config.yaml; null when no TDS
  msme               text not null default 'none' check (msme in ('micro', 'small', 'medium', 'none')),
  udyam_no           text,
  written_agreement  boolean not null default false,   -- MSME: 45 days with a written agreement, else 15
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 180),
  categories         text[] not null default '{}',
  phone              text,
  email              text,
  address            text,
  bank_name          text,
  bank_account       text,
  ifsc               text,
  upi                text,
  notes              text,
  active             boolean not null default true,
  created_at         timestamptz not null,
  updated_at         timestamptz not null
);

-- Agreed prices per purchase unit for a period; a PO line takes the vendor's current rate.
create table rate_contract (
  id          text primary key,
  vendor_id   text not null references vendor,
  item_id     text not null references item,
  rate_paise  bigint not null check (rate_paise > 0),
  valid_from  date not null,
  valid_to    date not null,
  check (valid_to >= valid_from)
);
create index rate_contract_item on rate_contract (item_id, valid_from);

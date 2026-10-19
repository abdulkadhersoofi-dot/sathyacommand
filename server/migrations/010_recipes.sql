-- Phase 3.5: kitchen ingredients and recipes. A recipe belongs to a dish code, so the same dish sold in
-- several outlets shares it. Sending a KOT takes the recipe's ingredients off the kitchen stock; receipts,
-- wastage and counts are movements too, so food cost can be worked out for any period.

create table ingredient (
  id               text primary key,
  name             text not null unique,
  unit             text not null check (unit in ('g', 'ml', 'pcs')),
  cost_per_unit    numeric(14,4) not null default 0,   -- paise per g / ml / piece, from the latest receipt
  par_level        numeric(14,3),                      -- reorder below this
  placeholder      boolean not null default false,
  active           boolean not null default true,
  created_at       timestamptz not null
);

create table recipe_line (
  dish_code      text not null,
  ingredient_id  text not null references ingredient,
  qty            numeric(12,3) not null check (qty > 0),   -- per portion, in the ingredient's unit
  primary key (dish_code, ingredient_id)
);

create table kitchen_stock_move (
  id             text primary key,
  ingredient_id  text not null references ingredient,
  business_date  date not null,
  kind           text not null check (kind in ('receipt', 'consumption', 'wastage', 'count_adjust')),
  qty            numeric(14,3) not null,                  -- in positive, out negative
  cost_paise     bigint not null default 0,               -- value at the time, signed like qty
  ref            text,
  note           text,
  by_user        text not null references app_user,
  at             timestamptz not null
);
create index kitchen_stock_move_ing on kitchen_stock_move (ingredient_id, business_date);
create index kitchen_stock_move_ref on kitchen_stock_move (ref);

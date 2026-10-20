-- Phase 5.2: indents (a department asks for goods) and purchase orders (numbered, gap-free, per vendor),
-- approved within each role's purchase limit.

create table indent (
  id             text primary key,
  number         text not null unique,
  store_id       text not null references store,        -- where the goods are wanted
  needed_by      date,
  note           text,
  status         text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'ordered', 'cancelled')),
  requested_by   text not null references app_user,
  requested_at   timestamptz not null,
  decided_by     text references app_user,
  decided_at     timestamptz,
  decision_note  text
);

create table indent_line (
  indent_id  text not null references indent,
  line       int not null,
  item_id    text not null references item,
  qty        numeric(14,3) not null check (qty > 0),     -- stock units
  note       text,
  po_id      text,                                       -- the purchase order it was ordered on
  primary key (indent_id, line)
);

create table purchase_order (
  id             text primary key,
  number         text not null unique,
  vendor_id      text not null references vendor,
  store_id       text not null references store,        -- deliver to
  status         text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'sent', 'partly_received', 'received', 'cancelled', 'closed')),
  order_date     date not null,
  expected_date  date,
  igst           boolean not null,                       -- vendor outside Tamil Nadu
  subtotal_paise bigint not null default 0,
  gst_paise      bigint not null default 0,
  total_paise    bigint not null default 0,
  terms          text,
  market_list    boolean not null default false,
  created_by     text not null references app_user,
  created_at     timestamptz not null,
  approval_id    text,
  approved_by    text references app_user,
  approved_at    timestamptz,
  sent_at        timestamptz,
  cancel_reason  text
);
create index purchase_order_status on purchase_order (status);

create table po_line (
  po_id         text not null references purchase_order,
  line          int not null,
  item_id       text not null references item,
  qty           numeric(14,3) not null check (qty > 0),  -- purchase units
  rate_paise    bigint not null check (rate_paise >= 0), -- per purchase unit, before GST
  gst_rate      numeric(5,2) not null default 0,
  amount_paise  bigint not null,
  gst_paise     bigint not null,
  received_qty  numeric(14,3) not null default 0,        -- purchase units, filled by goods receipts
  primary key (po_id, line)
);

-- The ledger of stores that keep their own stock (main, housekeeping, other): every receipt, issue,
-- transfer and count adjustment is a row; stock is a sum and nothing is overwritten.
create table stock_move (
  id             text primary key,
  item_id        text not null references item,
  store_id       text not null references store,
  business_date  date not null,
  kind           text not null check (kind in ('opening', 'receipt', 'issue', 'transfer_in', 'transfer_out', 'return', 'count_adjust', 'breakage', 'expired')),
  qty            numeric(14,3) not null,               -- stock units: in +, out -
  value_paise    bigint not null,                      -- signed like qty
  ref            text,
  note           text,
  by_user        text not null references app_user,
  at             timestamptz not null
);
create index stock_move_item on stock_move (item_id, store_id, business_date);

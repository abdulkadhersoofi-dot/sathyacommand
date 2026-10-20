-- Phase 5.3: goods received (with quality check, batches and expiry), vendor bills matched against the
-- PO and the receipt, payments with TDS, and the MSME payment due dates.

create table grn (
  id             text primary key,
  number         text not null unique,
  po_id          text references purchase_order,     -- null: bought without a PO (market cash purchase), flagged
  vendor_id      text not null references vendor,
  store_id       text not null references store,
  challan_no     text,
  business_date  date not null,
  photo_ids      text[] not null default '{}',
  note           text,
  value_paise    bigint not null default 0,          -- accepted goods at the PO rate, before GST
  received_by    text not null references app_user,
  received_at    timestamptz not null
);

create table grn_line (
  grn_id         text not null references grn,
  line           int not null,
  item_id        text not null references item,
  po_line        int,
  qty_received   numeric(14,3) not null check (qty_received >= 0),   -- purchase units
  qty_accepted   numeric(14,3) not null check (qty_accepted >= 0),
  reject_reason  text,
  rate_paise     bigint not null,
  batch_no       text,
  expiry         date,
  billed_qty     numeric(14,3) not null default 0,
  primary key (grn_id, line),
  check (qty_accepted <= qty_received)
);

-- Perishables and anything with a batch: what is left of each delivery, to issue first-to-expire first.
create table stock_batch (
  id         text primary key,
  item_id    text not null references item,
  store_id   text not null references store,
  grn_id     text references grn,
  batch_no   text,
  expiry     date,
  qty_in     numeric(14,3) not null,                 -- stock units
  qty_left   numeric(14,3) not null check (qty_left >= 0),
  created_at timestamptz not null
);
create index stock_batch_left on stock_batch (item_id, store_id, expiry) where qty_left > 0;

create table purchase_bill (
  id             text primary key,
  vendor_id      text not null references vendor,
  bill_no        text not null,
  bill_date      date not null,
  po_id          text references purchase_order,
  grn_ids        text[] not null default '{}',
  taxable_paise  bigint not null,
  cgst_paise     bigint not null default 0,
  sgst_paise     bigint not null default 0,
  igst_paise     bigint not null default 0,
  round_off_paise bigint not null default 0,
  total_paise    bigint not null,
  itc_paise      bigint not null default 0,          -- GST that can be claimed as input tax credit
  due_date       date not null,                      -- by payment terms
  msme_due_date  date,                               -- micro / small supplier: 15 or 45 days (deduction lost if later)
  match          text not null check (match in ('matched', 'difference', 'no_po')),
  differences    jsonb not null default '[]',
  status         text not null default 'entered' check (status in ('entered', 'approved', 'partly_paid', 'paid', 'cancelled')),
  paid_paise     bigint not null default 0,          -- settled, including TDS deducted
  photo_id       text,
  entered_by     text not null references app_user,
  entered_at     timestamptz not null,
  approved_by    text references app_user,
  approved_at    timestamptz,
  msme_alerted   boolean not null default false,
  unique (vendor_id, bill_no)
);

create table bill_line (
  bill_id       text not null references purchase_bill,
  line          int not null,
  item_id       text references item,                     -- null for a service (AMC, contractor, repair)
  description   text,
  sac           text,                                     -- HSN / SAC for a service line
  qty           numeric(14,3) not null check (qty > 0),   -- purchase units
  rate_paise    bigint not null check (rate_paise >= 0),
  gst_rate      numeric(5,2) not null,
  amount_paise  bigint not null,
  gst_paise     bigint not null,
  itc           text not null,
  primary key (bill_id, line),
  check (item_id is not null or description is not null)
);

create table vendor_payment (
  id            text primary key,
  number        text not null unique,
  vendor_id     text not null references vendor,
  pay_date      date not null,
  mode          text not null check (mode in ('bank', 'upi', 'cheque', 'cash')),
  reference     text,                                 -- UTR, cheque number
  gross_paise   bigint not null,                      -- bills settled
  tds_paise     bigint not null default 0,
  tds_code      text,
  tds_section   text,
  tds_base_paise bigint not null default 0,
  tds_rate      numeric(5,2),
  net_paise     bigint not null,                      -- paid to the vendor
  status        text not null check (status in ('pending_approval', 'approved', 'paid', 'cancelled')),
  approval_id   text,
  created_by    text not null references app_user,
  created_at    timestamptz not null,
  paid_by       text references app_user,
  paid_at       timestamptz
);

create table payment_alloc (
  payment_id    text not null references vendor_payment,
  bill_id       text not null references purchase_bill,
  amount_paise  bigint not null check (amount_paise > 0),
  primary key (payment_id, bill_id)
);

-- TDS deducted from vendors: what is owed to the government, by section and quarter (deposited in Phase 6).
create table tds_entry (
  id           text primary key,
  vendor_id    text not null references vendor,
  payment_id   text not null references vendor_payment,
  code         text not null,
  section      text not null,
  fy           text not null,
  quarter      int not null check (quarter between 1 and 4),
  base_paise   bigint not null,
  rate         numeric(5,2) not null,
  tds_paise    bigint not null,
  deducted_on  date not null,
  pan          text
);

-- Phase 3.3: restaurant and bar billing. Food and soft drinks go on a GST tax invoice from their own
-- series (RST/…); liquor goes on a TN VAT invoice from a separate series (VAT/…). One payment can
-- cover both. A bill can also be charged to a checked-in guest's room bill.

alter table property
  add column upi_vpa                 text,      -- UPI ID printed as a QR code on restaurant bills
  add column upi_payee               text,
  add column service_charge_percent  numeric(5,2) not null default 0;

alter table tax_document drop constraint tax_document_doc_type_check;
alter table tax_document add constraint tax_document_doc_type_check
  check (doc_type in ('invoice', 'fnb_invoice', 'credit_note', 'receipt_voucher', 'refund_voucher'));

alter table folio_line drop constraint folio_line_kind_check;
alter table folio_line add constraint folio_line_kind_check
  check (kind in ('room', 'extra_bed', 'laundry', 'misc', 'fnb', 'liquor', 'payment', 'refund', 'reversal'));

-- Liquor is outside GST, so its invoices live apart from tax_document, and are just as final.
create table vat_invoice (
  id               text primary key,
  number           text not null unique,
  fy               text not null,
  issue_date       date not null,
  seller           jsonb not null,
  buyer            jsonb not null,
  lines            jsonb not null,
  taxable_paise    bigint not null,
  vat_paise        bigint not null,
  total_paise      bigint not null,
  amount_in_words  text not null,
  issued_by        text not null references app_user,
  issued_at        timestamptz not null
);
create function vat_invoice_guard() returns trigger language plpgsql as $$
begin
  raise exception 'VAT invoices cannot be changed or deleted';
end $$;
create trigger vat_invoice_immutable before update or delete on vat_invoice
  for each row execute function vat_invoice_guard();

create table fnb_bill (
  id                 text primary key,
  order_id           text not null references fnb_order,
  part               int not null,
  parts              int not null,
  status             text not null default 'open' check (status in ('open', 'settled', 'void')),
  item_ids           text[],                       -- split by items; null = a share of the whole order
  share_num          int not null default 1,
  share_den          int not null default 1,
  discount_percent   numeric(5,2) not null default 0,
  discount_reason    text,
  service_percent    numeric(5,2) not null default 0,
  bill_to            jsonb,                        -- company name, GSTIN, address for a B2B bill
  amounts            jsonb not null,               -- computed lines and totals, frozen at settlement
  total_paise        bigint not null,
  prints             int not null default 0,
  gst_document_id    text references tax_document,
  vat_invoice_id     text references vat_invoice,
  reservation_id     text references reservation,  -- charged to this room
  created_by         text not null references app_user,
  created_at         timestamptz not null,
  settled_by         text references app_user,
  settled_at         timestamptz
);
create index fnb_bill_order on fnb_bill (order_id);

create table fnb_payment (
  id             text primary key,
  bill_id        text not null references fnb_bill,
  method         text not null check (method in ('cash', 'card', 'upi', 'company', 'room')),
  amount_paise   bigint not null check (amount_paise > 0),
  reference      text,
  shift_id       text references cashier_shift,
  received_by    text not null references app_user,
  business_date  date not null,
  at             timestamptz not null
);
create index fnb_payment_shift on fnb_payment (shift_id);
create index fnb_payment_date on fnb_payment (business_date);

-- Items keep the order they were taken in, even when several are added in the same instant.
alter table order_item add column seq bigserial;

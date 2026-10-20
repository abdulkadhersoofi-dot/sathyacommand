-- Phase 6.4: GST returns. Vendor bills can carry services under reverse charge (the resort pays the GST to the
-- government, not the vendor). Each bill's input tax credit follows the portal: it is claimed in the month it
-- appears in GSTR-2B, unless accounts rejected it in the Invoice Management System (IMS). Returns filed (with
-- their ARN) keep the figures as filed and close the month for GST.

alter table bill_line add column rcm boolean not null default false;
alter table purchase_bill
  add column rcm_paise    bigint not null default 0,         -- GST payable by the resort under reverse charge
  add column ims_action   text not null default 'pending' check (ims_action in ('pending', 'accepted', 'rejected')),
  add column ims_note     text,
  add column ims_by       text references app_user,
  add column ims_at       timestamptz;

create table gstr2b_import (
  id           text primary key,
  period       text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  file_name    text,
  lines        int not null,
  imported_by  text not null references app_user,
  imported_at  timestamptz not null
);

-- One supplier document in GSTR-2B, and the bill (or OTA commission invoice) it was matched to.
create table gstr2b_line (
  id               text primary key,
  import_id        text not null references gstr2b_import,
  period           text not null,
  doc_type         text not null default 'invoice' check (doc_type in ('invoice', 'credit_note', 'debit_note')),
  supplier_gstin   text not null,
  supplier_name    text,
  doc_no           text not null,
  doc_date         date,
  value_paise      bigint not null default 0,
  taxable_paise    bigint not null default 0,
  igst_paise       bigint not null default 0,
  cgst_paise       bigint not null default 0,
  sgst_paise       bigint not null default 0,
  itc_available    boolean not null default true,
  reason           text,
  bill_id          text references purchase_bill,
  ota_payout_id    text references ota_payout,
  status           text not null default 'unmatched' check (status in ('matched', 'mismatch', 'unmatched')),
  unique (period, supplier_gstin, doc_type, doc_no)
);
create index gstr2b_line_bill on gstr2b_line (bill_id) where bill_id is not null;

create table gst_return (
  id         text primary key,
  period     text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  form       text not null check (form in ('GSTR1', 'GSTR3B')),
  arn        text not null,
  filed_on   date not null,
  figures    jsonb not null,
  voucher_id text references voucher,
  filed_by   text not null references app_user,
  filed_at   timestamptz not null,
  unique (period, form)
);

-- GST documents: tax invoices, credit notes, receipt vouchers (advances), refund vouchers, and e-invoice (IRN) details.

alter table property
  add column address        text,
  add column city           text,
  add column pin            text,
  add column invoice_prefix text not null default 'SPR';

alter table reservation
  add column bill_to_address text,
  add column bill_to_city    text,
  add column bill_to_pin     text;

-- One counter per document type per financial year, bumped inside the issuing transaction,
-- so numbers are consecutive with no gaps even when an issue fails and rolls back.
create table doc_series (
  doc_type     text not null,
  fy           text not null,
  next_serial  int not null,
  primary key (doc_type, fy)
);

create table tax_document (
  id                      text primary key,
  doc_type                text not null check (doc_type in ('invoice','credit_note','receipt_voucher','refund_voucher')),
  number                  text not null unique,
  fy                      text not null,
  issue_date              date not null,
  reservation_id          text references reservation,
  folio_id                text references folio,
  original_id             text references tax_document,
  supplier                jsonb not null,
  recipient               jsonb not null,
  b2b                     boolean not null,
  place_of_supply         text not null,
  reverse_charge          boolean not null default false,
  lines                   jsonb not null,
  tax_summary             jsonb not null,
  taxable_paise           bigint not null,
  cgst_paise              bigint not null,
  sgst_paise              bigint not null,
  total_paise             bigint not null,
  advance_adjusted_paise  bigint not null default 0,
  amount_in_words         text not null,
  reason                  text,
  irn_status              text not null check (irn_status in ('not_required','pending','generated','failed')),
  irn_deadline            date,
  irn                     text,
  ack_no                  text,
  ack_date                timestamptz,
  signed_qr               text,
  irn_error               text,
  issued_by               text not null references app_user,
  issued_at               timestamptz not null
);
create index tax_document_reservation on tax_document (reservation_id);
create index tax_document_irn_pending on tax_document (irn_deadline) where irn_status in ('pending','failed');

-- Issued documents are final: only the e-invoice fields may be filled in later. Corrections are credit notes.
create function tax_document_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'tax documents cannot be deleted';
  end if;
  if (new.number, new.doc_type, new.issue_date, new.lines, new.tax_summary, new.total_paise, new.taxable_paise,
      new.recipient, new.supplier, new.original_id)
     is distinct from
     (old.number, old.doc_type, old.issue_date, old.lines, old.tax_summary, old.total_paise, old.taxable_paise,
      old.recipient, old.supplier, old.original_id) then
    raise exception 'issued tax documents cannot be changed; issue a credit note instead';
  end if;
  return new;
end $$;
create trigger tax_document_immutable before update or delete on tax_document
  for each row execute function tax_document_guard();

alter table payment add column voucher_id text references tax_document;

-- Licences and permits (numbers printed on bills, renewal dates) and TN VAT rates for liquor, both kept
-- in the database so the MD and accounts can add and change them in the app. Every change is logged.

create table licence (
  id           text primary key,
  kind         text not null,                      -- fssai, fl3, tn_vat, trade, fire_noc, ...
  name         text not null,
  number       text not null,
  authority    text,
  valid_from   date,
  valid_until  date,
  print_on     text[] not null default '{}',       -- fnb_bill, vat_bill, room_invoice
  notes        text,
  active       boolean not null default true,
  updated_by   text not null references app_user,
  updated_at   timestamptz not null
);

create table liquor_class (
  id      text primary key,
  label   text not null,
  active  boolean not null default true
);

-- A rate applies from its date until the next one, so bills on earlier dates keep the old rate.
create table vat_rate (
  liquor_class    text not null references liquor_class,
  effective_from  date not null,
  rate            numeric(5,2) not null check (rate >= 0 and rate <= 100),
  note            text,
  set_by          text not null references app_user,
  set_at          timestamptz not null,
  primary key (liquor_class, effective_from)
);

-- FSSAI now lives with the other licences.
alter table property drop column fssai_no;

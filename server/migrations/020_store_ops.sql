-- Phase 5.4: store operations. Issues to departments and transfers between stores (against an indent or
-- not), physical counts with the variance approved before the book changes, and the breakage register.

alter table indent_line add column issued_qty numeric(14,3) not null default 0;
alter table indent drop constraint indent_status_check;
alter table indent add constraint indent_status_check check (status in ('submitted', 'approved', 'rejected', 'ordered', 'issued', 'cancelled'));

create table stock_issue (
  id             text primary key,
  number         text not null unique,
  from_store_id  text not null references store,
  to_store_id    text references store,               -- a transfer into another store's book
  department     text,                                -- or used up by a department
  indent_id      text references indent,
  note           text,
  value_paise    bigint not null default 0,
  business_date  date not null,
  issued_by      text not null references app_user,
  issued_at      timestamptz not null,
  check (to_store_id is not null or department is not null)
);

create table stock_issue_line (
  issue_id     text not null references stock_issue,
  line         int not null,
  item_id      text not null references item,
  qty          numeric(14,3) not null check (qty > 0),  -- stock units
  value_paise  bigint not null,
  primary key (issue_id, line)
);

create table stock_count (
  id                    text primary key,
  number                text not null unique,
  store_id              text not null references store,
  business_date         date not null,
  status                text not null check (status in ('pending_approval', 'applied', 'rejected')),
  variance_value_paise  bigint not null,                -- net: shortages negative
  variance_abs_paise    bigint not null,                -- shortages and excesses added up
  book_value_paise      bigint not null,
  note                  text,
  approval_id           text,
  counted_by            text not null references app_user,
  counted_at            timestamptz not null,
  decided_by            text references app_user,
  decided_at            timestamptz
);

create table stock_count_line (
  count_id        text not null references stock_count,
  item_id         text not null references item,
  book_qty        numeric(14,3) not null,
  counted_qty     numeric(14,3) not null check (counted_qty >= 0),
  avg_cost_paise  numeric(14,4) not null,
  variance_paise  bigint not null,
  primary key (count_id, item_id)
);

-- Crockery, cutlery and glassware broken: out of stock at cost, and charged to the guest or recorded against staff when so.
create table breakage (
  id              text primary key,
  store_id        text not null references store,
  item_id         text not null references item,
  qty             numeric(14,3) not null check (qty > 0),
  value_paise     bigint not null,
  department      text not null,
  charge_to       text not null check (charge_to in ('house', 'guest', 'staff')),
  reservation_id  text references reservation,
  staff_name      text,
  charged_paise   bigint not null default 0,
  note            text,
  photo_id        text,
  by_user         text not null references app_user,
  at              timestamptz not null
);

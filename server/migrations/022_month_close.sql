-- Phase 5.6: month close. Each store's month is valued (opening, receipts, issues, losses, count variance,
-- closing), its closing count checked, its variance held against the limit agreed for that store, and the
-- GM signs it off. A closed month is locked: no stock movement can be dated in it.

alter table store add column variance_limit_percent numeric(5,2) not null default 1 check (variance_limit_percent >= 0);

create table month_close (
  id                 text primary key,
  store_id           text not null references store,
  month              text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status             text not null check (status in ('pending_approval', 'closed', 'rejected')),
  opening_paise      bigint not null,
  receipts_paise     bigint not null,
  issues_paise       bigint not null,             -- out to departments and other stores, or used (signed: out negative)
  losses_paise       bigint not null,             -- breakage, expiry, wastage, discards (out negative)
  variance_paise     bigint not null,             -- count adjustments: shortages negative
  closing_paise      bigint not null,
  base_paise         bigint not null,             -- what the variance is a share of: the month's consumption
  variance_percent   numeric(7,2) not null,
  limit_percent      numeric(5,2) not null,
  count_ref          text,                        -- the closing count
  count_date         date,
  food               jsonb,                       -- kitchen: theoretical against actual food cost
  note               text,
  approval_id        text,
  prepared_by        text not null references app_user,
  prepared_at        timestamptz not null,
  decided_by         text references app_user,
  decided_at         timestamptz
);
create unique index month_close_one on month_close (store_id, month) where status <> 'rejected';

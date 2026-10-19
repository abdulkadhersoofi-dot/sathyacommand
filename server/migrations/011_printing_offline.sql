-- Phase 3.6: network printers for kitchen, bar and bills, a queue of print jobs that the print agent
-- on the resort's edge box sends to them, and idempotency keys so a tablet that lost its connection
-- can resend an order without it being taken twice.

create table printer (
  id          text primary key,
  name        text not null,
  host        text not null,
  port        int not null default 9100 check (port between 1 and 65535),
  width       int not null default 48 check (width between 24 and 64),   -- characters per line (80 mm = 48, 58 mm = 32)
  active      boolean not null default true,
  created_at  timestamptz not null
);

alter table station add column printer_id text references printer;
alter table outlet add column bill_printer_id text references printer;

create table print_job (
  id          text primary key,
  printer_id  text not null references printer,
  kind        text not null check (kind in ('kot', 'bill', 'test')),
  ref         text,
  doc         jsonb not null,
  status      text not null default 'queued' check (status in ('queued', 'printing', 'done', 'failed')),
  attempts    int not null default 0,
  error       text,
  claimed_at  timestamptz,
  created_at  timestamptz not null,
  done_at     timestamptz
);
create index print_job_queue on print_job (status, created_at) where status in ('queued', 'printing');

create table idempotency_key (
  key         text not null,
  scope       text not null,          -- hash of the caller's session token
  status      int not null,
  body        text not null,
  created_at  timestamptz not null,
  primary key (scope, key)
);

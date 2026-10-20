-- Phase 5.5: excise. TASMAC purchases carry the transport permit and the TCS collected (a tax credit to
-- claim); peg measures and scales are registered with their legal-metrology stamping dates.

alter table tasmac_purchase add column permit_no text;
alter table tasmac_purchase add column permit_date date;
alter table tasmac_purchase add column tcs_paise bigint not null default 0;

create table measure (
  id          text primary key,
  name        text not null,
  kind        text not null check (kind in ('peg_measure', 'scale', 'dispenser', 'other')),
  capacity    text,                               -- 30 ml, 60 ml, 0–30 kg …
  location    text,
  stamp_no    text,
  stamped_on  date,
  due_on      date,                               -- next verification and stamping
  reminded    int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null
);

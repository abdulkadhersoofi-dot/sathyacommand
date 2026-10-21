-- Phase 8.2: the monthly payroll. A run for a month works out each person's pay from their structure,
-- attendance and leave, with PF, ESI, professional tax and the labour welfare fund; HR submits it, the GM
-- checks it and the MD approves it; accounts pay it from the bank and pay the statutory dues. Each line keeps
-- what it was worked out from, so a payslip reads the same years later.

create table payroll_run (
  id              text primary key,
  month           text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status          text not null default 'draft' check (status in ('draft', 'submitted', 'checked', 'approved', 'paid', 'cancelled')),
  days_in_month   int not null,
  pf_admin_paise  bigint not null default 0,      -- the establishment's EPF admin charges for the month
  note            text,
  created_by      text not null references app_user,
  created_at      timestamptz not null,
  calculated_at   timestamptz not null,
  submitted_by    text references app_user,
  submitted_at    timestamptz,
  checked_by      text references app_user,
  checked_at      timestamptz,
  approved_by     text references app_user,
  approved_at     timestamptz,
  sent_back_note  text,
  paid_on         date,
  paid_by         text references app_user,
  bank_code       text references account,
  pay_reference   text
);
create unique index payroll_run_month on payroll_run (month) where status <> 'cancelled';

create table payroll_line (
  run_id                text not null references payroll_run,
  employee_id           text not null references employee,
  code                  text not null,
  name                  text not null,
  department            text not null,
  ledger_dept           text not null,
  designation           text not null,
  uan                   text,
  esic_ip               text,
  pan                   text,
  bank_account          text,
  ifsc                  text,
  -- what HR may change before submitting (null: as worked out from attendance and leave)
  lop_set               numeric(5,1),
  ot_set                numeric(6,1),
  other_earnings_paise  bigint not null default 0,
  note                  text,
  lop_days              numeric(5,1) not null default 0,
  ot_hours              numeric(6,1) not null default 0,
  -- worked out from the above
  employed_days         int not null,
  paid_days             numeric(5,1) not null,
  absent_days           numeric(5,1) not null default 0,    -- rostered, not in and not on leave (counted in lop_days)
  leave_lop_days        numeric(5,1) not null default 0,    -- approved leave without pay (counted in lop_days)
  basic_paise           bigint not null default 0,
  da_paise              bigint not null default 0,
  hra_paise             bigint not null default 0,
  conveyance_paise      bigint not null default 0,
  special_paise         bigint not null default 0,
  other_paise           bigint not null default 0,
  overtime_paise        bigint not null default 0,
  gross_paise           bigint not null,
  wages_paise           bigint not null,                    -- wages under the Code on Wages, as earned
  pf_wages_paise        bigint not null default 0,
  eps_wages_paise       bigint not null default 0,
  edli_wages_paise      bigint not null default 0,
  pf_employee_paise     bigint not null default 0,
  eps_paise             bigint not null default 0,
  pf_employer_paise     bigint not null default 0,          -- the employer's 12% less EPS, to the EPF account
  edli_paise            bigint not null default 0,
  esi_covered           boolean not null default false,
  esi_wages_paise       bigint not null default 0,
  esi_employee_paise    bigint not null default 0,
  esi_employer_paise    bigint not null default 0,
  pt_paise              bigint not null default 0,
  lwf_employee_paise    bigint not null default 0,
  lwf_employer_paise    bigint not null default 0,
  tds_paise             bigint not null default 0,
  other_deductions_paise bigint not null default 0,
  net_paise             bigint not null,
  bonus_provision_paise bigint not null default 0,
  gratuity_provision_paise bigint not null default 0,
  warnings              jsonb not null default '[]',
  primary key (run_id, employee_id)
);

-- PF, ESI, professional tax and welfare fund paid to the authorities for a month.
create table statutory_payment (
  id          text primary key,
  month       text not null,
  kind        text not null check (kind in ('pf', 'esi', 'pt', 'lwf')),
  amount_paise bigint not null check (amount_paise > 0),
  paid_on     date not null,
  reference   text not null,                      -- PF TRRN, ESI challan number, receipt number
  bank_code   text not null references account,
  created_by  text not null references app_user,
  created_at  timestamptz not null
);
create index statutory_payment_month on statutory_payment (month, kind);

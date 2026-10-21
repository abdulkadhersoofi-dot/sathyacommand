-- Phase 8.3: income tax on salaries from each person's declaration, salary advances and loans recovered
-- through the payroll, the full and final settlement when someone leaves, and the comparison with the
-- payroll the resort runs today (the parallel run).

-- What a person declares for the year's tax: the regime, rent, investments and income from an earlier
-- employer in the same year. Proofs are checked by HR before the last quarter.
create table tax_declaration (
  employee_id           text not null references employee,
  fy                    text not null,
  regime                text not null default 'new' check (regime in ('new', 'old')),
  rent_paid_paise       bigint not null default 0,        -- a month
  sec80c_paise          bigint not null default 0,
  sec80d_paise          bigint not null default 0,
  home_loan_interest_paise bigint not null default 0,
  other_deductions_paise bigint not null default 0,
  previous_income_paise bigint not null default 0,        -- salary from an earlier employer this year
  previous_tds_paise    bigint not null default 0,
  proofs_checked        boolean not null default false,
  updated_by            text not null references app_user,
  updated_at            timestamptz not null,
  primary key (employee_id, fy)
);

-- Salary advances (recovered in a few months) and loans (in instalments).
create table salary_advance (
  id              text primary key,
  employee_id     text not null references employee,
  kind            text not null check (kind in ('advance', 'loan')),
  amount_paise    bigint not null check (amount_paise > 0),
  instalment_paise bigint not null check (instalment_paise > 0),
  reason          text not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'active', 'closed', 'rejected')),
  requested_by    text not null references app_user,
  requested_at    timestamptz not null,
  decided_by      text references app_user,
  decided_at      timestamptz,
  issued_on       date,
  bank_code       text references account,
  reference       text
);
create index salary_advance_employee on salary_advance (employee_id);

alter table payroll_line add column advance_recovery_paise bigint not null default 0;
alter table payroll_line add column tds_detail jsonb;
alter table statutory_payment drop constraint statutory_payment_kind_check;
alter table statutory_payment add constraint statutory_payment_kind_check check (kind in ('pf', 'esi', 'pt', 'lwf', 'tds'));

-- The full and final settlement: what is owed to (or by) someone who has left, besides their last month's pay.
create table settlement (
  id            text primary key,
  employee_id   text not null references employee,
  last_day      date not null,
  ledger_dept   text not null,                            -- the department its costs go to
  items         jsonb not null,                           -- [{ key, label, amount_paise, detail }]
  net_paise     bigint not null,
  status        text not null default 'draft' check (status in ('draft', 'approved', 'paid', 'cancelled')),
  note          text,
  created_by    text not null references app_user,
  created_at    timestamptz not null,
  approved_by   text references app_user,
  approved_at   timestamptz,
  paid_on       date,
  bank_code     text references account,
  reference     text
);
create unique index settlement_one on settlement (employee_id) where status <> 'cancelled';

-- The current payroll's figures for a month, put beside the system's run.
create table payroll_compare (
  id           text primary key,
  seq          bigint generated always as identity,
  run_id       text not null references payroll_run,
  rows         jsonb not null,                            -- [{ code, gross, pf, esi, pt, lwf, tds, net }] in paise
  uploaded_by  text not null references app_user,
  uploaded_at  timestamptz not null
);

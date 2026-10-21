-- Phase 8.1: HR records. Employees (with or without a login), their salary structure over time, documents
-- and onboarding, leave (credits, applications, approvals), the holiday calendar and training certificates.

create table employee (
  id               text primary key,
  code             text not null unique,
  name             text not null,
  user_id          text unique references app_user,
  department       text not null,
  designation      text not null,
  employment_type  text not null default 'permanent' check (employment_type in ('permanent','probation','fixed_term','contract','trainee')),
  joined_on        date not null,
  confirmed_on     date,
  fixed_term_until date,
  exit_on          date,
  exit_reason      text,
  status           text not null default 'active' check (status in ('active','notice','exited')),
  gender           text check (gender in ('female','male','other')),
  dob              date,
  guardian         text,
  mobile           text,
  email            text,
  address          text,
  emergency        text,
  pan              text,
  aadhaar_last4    text check (aadhaar_last4 ~ '^[0-9]{4}$'),
  uan              text,
  esic_ip          text,
  pf_member        boolean not null default true,
  pt_applicable    boolean not null default true,
  lwf_applicable   boolean not null default true,
  bank_name        text,
  bank_account     text,
  ifsc             text,
  tax_regime       text not null default 'new' check (tax_regime in ('new','old')),
  photo_id         text references upload,
  created_at       timestamptz not null,
  updated_at       timestamptz not null
);
create index employee_department on employee (department) where status <> 'exited';

-- Monthly pay, from a date: a change is a new row, so past months keep their structure.
create table salary_structure (
  employee_id      text not null references employee,
  effective_from   date not null,
  basic_paise      bigint not null check (basic_paise >= 0),
  da_paise         bigint not null default 0 check (da_paise >= 0),
  hra_paise        bigint not null default 0 check (hra_paise >= 0),
  conveyance_paise bigint not null default 0 check (conveyance_paise >= 0),
  special_paise    bigint not null default 0 check (special_paise >= 0),
  other_paise      bigint not null default 0 check (other_paise >= 0),
  pf_on_full_wages boolean not null default false,       -- the employee chose PF above the ceiling
  set_by           text not null references app_user,
  set_at           timestamptz not null,
  primary key (employee_id, effective_from)
);

create table employee_document (
  id           text primary key,
  employee_id  text not null references employee,
  kind         text not null check (kind in ('appointment','id_proof','address_proof','pan','bank_proof','photo','medical','certificate','exit','other')),
  upload_id    text references upload,
  note         text,
  added_by     text not null references app_user,
  added_at     timestamptz not null
);

create table onboarding_item (
  employee_id  text not null references employee,
  item         text not null,
  done_by      text references app_user,
  done_at      timestamptz,
  primary key (employee_id, item)
);

-- Leave: every credit, debit and adjustment is an entry; the balance is their sum for the leave year.
create table leave_entry (
  id           text primary key,
  employee_id  text not null references employee,
  leave_type   text not null,
  year         int not null,
  days         numeric(6,1) not null,
  reason       text not null,
  ref          text,
  by_user      text references app_user,
  at           timestamptz not null
);
create unique index leave_entry_ref on leave_entry (employee_id, leave_type, ref) where ref is not null;
create index leave_entry_balance on leave_entry (employee_id, year, leave_type);

create table leave_application (
  id            text primary key,
  employee_id   text not null references employee,
  leave_type    text not null,
  from_date     date not null,
  to_date       date not null,
  half_day      boolean not null default false,
  days          numeric(6,1) not null check (days > 0),
  reason        text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  applied_by    text not null references app_user,
  applied_at    timestamptz not null,
  decided_by    text references app_user,
  decided_at    timestamptz,
  decision_note text,
  check (to_date >= from_date)
);
create index leave_application_open on leave_application (status, from_date);

create table holiday (
  day   date primary key,
  name  text not null,
  kind  text not null check (kind in ('national','festival','optional'))
);

create table training_record (
  id           text primary key,
  employee_id  text not null references employee,
  kind         text not null check (kind in ('fssai_food_handler','fire_drill','first_aid','hygiene','responsible_service','safety','other')),
  title        text not null,
  done_on      date not null,
  valid_until  date,
  upload_id    text references upload,
  added_by     text not null references app_user,
  added_at     timestamptz not null
);

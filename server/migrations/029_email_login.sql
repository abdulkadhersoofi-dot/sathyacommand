-- Sign-in by email and password. The mobile number stays on the login for SMS codes later, but is optional.

alter table app_user
  add column email                text unique,
  add column password_hash        text,
  add column must_change_password boolean not null default false,
  add column failed_logins        int not null default 0,
  add column locked_until         timestamptz;

-- A session made with a temporary password can only set a new one.
alter table user_session drop constraint user_session_scope_check;
alter table user_session add constraint user_session_scope_check check (scope in ('full', 'enroll_2fa', 'set_password'));

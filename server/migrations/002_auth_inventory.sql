-- Sign-in, devices, approvals, and editable room inventory.

alter table app_user
  add column totp_secret   text,
  add column totp_enabled  boolean not null default false,
  add column locked_reason text;

alter table device add column last_seen timestamptz;

alter table room_type add column updated_at timestamptz not null default now();
alter table space add column updated_at timestamptz not null default now();

-- Lodging kinds grow with the resort (cottages, tents); the 3D model draws each kind differently.
alter table space drop constraint space_kind_check;
alter table space add constraint space_kind_check check (kind in (
  'room','villa','suite','cottage','tent','dormitory',
  'hall','lawn','pavilion','ground','restaurant','kitchen','bar','reception','pool','store','service','office'));

-- One-time sign-in codes sent by SMS. Only a hash of the code is stored.
create table otp_challenge (
  id          text primary key,
  mobile      text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index otp_challenge_mobile on otp_challenge (mobile, created_at);

-- Waiting for the second factor (authenticator code) after a correct SMS code.
create table login_challenge (
  id          text primary key,
  user_id     text not null references app_user,
  device_id   text,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used        boolean not null default false
);

-- Signed-in sessions. Only a hash of the token is stored; expiry slides with use.
create table user_session (
  id            text primary key,
  token_hash    text not null unique,
  user_id       text not null references app_user,
  device_id     text,
  scope         text not null default 'full' check (scope in ('full', 'enroll_2fa')),
  idle_minutes  int not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index user_session_by_user on user_session (user_id) where revoked_at is null;

-- Approval inbox: anything above someone's authority waits here for the right person.
create table approval (
  id            text primary key,
  kind          text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by  text not null references app_user,
  payload       jsonb not null,
  reason        text,
  decided_by    text references app_user,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index approval_pending on approval (status, created_at);

-- Role permissions are synced from seed/roles-and-approvals.yaml at every start.
alter table role add column permissions text[] not null default '{}';

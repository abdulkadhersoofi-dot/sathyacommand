-- The resort's profile, set by the MD in Settings: contact details beside the tax details already kept, and
-- when the business day closes by itself if nobody has closed it.
alter table property
  add column pan            text,
  add column phone          text,
  add column email          text,
  add column website        text,
  add column auto_close     boolean not null default true,
  add column day_close_at   text not null default '03:00' check (day_close_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

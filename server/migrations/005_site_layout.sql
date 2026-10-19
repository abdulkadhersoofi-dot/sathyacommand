-- Twin Studio: every version of the resort's 3D layout. Exactly one is published at a time;
-- older versions are kept so any of them can be restored.

create table site_version (
  id            serial primary key,
  status        text not null check (status in ('draft', 'published', 'superseded')),
  layout        jsonb not null,
  note          text,
  based_on      int references site_version,
  created_by    text not null references app_user,
  created_at    timestamptz not null,
  published_by  text references app_user,
  published_at  timestamptz
);
create unique index site_one_published on site_version (status) where status = 'published';

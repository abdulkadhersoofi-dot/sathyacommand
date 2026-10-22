-- Food places: any place on the map can serve food. An outlet may serve another outlet's menu (the Grand
-- Lawn serves Sathya Dine's menu) instead of keeping its own, and there are more kinds than the first five.
alter table outlet add column menu_of text references outlet;
alter table outlet drop constraint outlet_kind_check;
alter table outlet add constraint outlet_kind_check
  check (kind in ('restaurant', 'cafe', 'bar', 'poolside', 'lawn', 'room_service', 'banquet'));

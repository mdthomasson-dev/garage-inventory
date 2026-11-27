-- =====================================================================
-- Garage Inventory: one-time Supabase setup
--
-- 1. Change the two email addresses in the LAST section of this file
--    to yours and your household's (anyone listed can see and edit everything).
-- 2. Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- Safe to run again later (e.g. to add another person).
-- =====================================================================

-- ---------- who is allowed in ----------
create table if not exists public.household_members (
  email text primary key
);

-- True when the signed-in user has a confirmed email that's on the household list.
create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members m
    join auth.users u on lower(u.email) = lower(m.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;

-- ---------- data ----------
create table if not exists public.boxes (
  code        text primary key,
  name        text not null default '',
  location    text not null default '',
  notes       text not null default '',
  items       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  box_code    text not null references public.boxes(code) on delete cascade on update cascade,
  path        text not null,
  thumb_path  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists photos_box_code_idx on public.photos (box_code);

-- Shared settings, e.g. the household's Gemini API key.
create table if not exists public.app_settings (
  key   text primary key,
  value text not null default ''
);

create table if not exists public.counters (
  name  text primary key,
  value int not null default 0
);

-- Hands out the next unused box codes: BOX-001, BOX-002, ...
create or replace function public.reserve_codes(n int)
returns text[]
language plpgsql security definer
set search_path = public
as $$
declare
  cur int;
  mx  int;
  result text[] := '{}';
begin
  if not public.is_member() then
    raise exception 'Not allowed';
  end if;
  if n < 1 or n > 200 then
    raise exception 'Ask for between 1 and 200 codes';
  end if;
  insert into public.counters (name, value) values ('box', 0) on conflict do nothing;
  select value into cur from public.counters where name = 'box' for update;
  select coalesce(max(substring(code from '^BOX-(\d+)$')::int), 0) into mx from public.boxes;
  cur := greatest(cur, mx);
  for i in 1..n loop
    cur := cur + 1;
    result := result || ('BOX-' || lpad(cur::text, greatest(3, length(cur::text)), '0'));
  end loop;
  update public.counters set value = cur where name = 'box';
  return result;
end;
$$;

-- ---------- security: only household members can read or write ----------
alter table public.household_members enable row level security;
alter table public.boxes             enable row level security;
alter table public.photos            enable row level security;
alter table public.app_settings      enable row level security;
alter table public.counters          enable row level security;  -- no policies: only reserve_codes() touches it

drop policy if exists "members see members" on public.household_members;
create policy "members see members" on public.household_members
  for select to authenticated using (public.is_member());

drop policy if exists "members manage boxes" on public.boxes;
create policy "members manage boxes" on public.boxes
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members manage photos" on public.photos;
create policy "members manage photos" on public.photos
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members manage settings" on public.app_settings;
create policy "members manage settings" on public.app_settings
  for all to authenticated using (public.is_member()) with check (public.is_member());

grant select on public.household_members to authenticated;
grant select, insert, update, delete on public.boxes, public.photos, public.app_settings to authenticated;
revoke all on public.counters from anon, authenticated;
revoke execute on function public.reserve_codes(int) from public, anon;
grant execute on function public.reserve_codes(int) to authenticated;
grant execute on function public.is_member() to authenticated;

-- ---------- photo storage (private bucket) ----------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "members read photos" on storage.objects;
create policy "members read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_member());

drop policy if exists "members add photos" on storage.objects;
create policy "members add photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.is_member());

drop policy if exists "members change photos" on storage.objects;
create policy "members change photos" on storage.objects
  for update to authenticated using (bucket_id = 'photos' and public.is_member());

drop policy if exists "members delete photos" on storage.objects;
create policy "members delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.is_member());

-- ---------- live updates between phones ----------
do $$
begin
  alter publication supabase_realtime add table public.boxes;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.photos;
exception when duplicate_object then null;
end $$;

-- ---------- YOUR HOUSEHOLD: change these two emails ----------
insert into public.household_members (email) values
  ('your-email@example.com'),
  ('your-wifes-email@example.com')
on conflict do nothing;

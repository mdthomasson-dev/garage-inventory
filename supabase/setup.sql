-- =====================================================================
-- Garage Inventory: one-time Supabase setup
--
-- 1. Change the two email addresses in the LAST section of this file
--    to yours and your household's (anyone listed can see and edit everything).
-- 2. Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- Safe to run again later (e.g. to add another person).
-- Everything it creates starts with "garage", so it can share a project with other apps.
-- =====================================================================

-- ---------- who is allowed in ----------
create table if not exists public.garage_members (
  email text primary key
);

-- True when the signed-in user has a confirmed email that's on the household list.
create or replace function public.garage_is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.garage_members m
    join auth.users u on lower(u.email) = lower(m.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null
  );
$$;

-- ---------- data ----------
create table if not exists public.garage_boxes (
  code        text primary key,
  name        text not null default '',
  location    text not null default '',
  notes       text not null default '',
  items       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.garage_photos (
  id          uuid primary key default gen_random_uuid(),
  box_code    text not null references public.garage_boxes(code) on delete cascade on update cascade,
  path        text not null,
  thumb_path  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists garage_photos_box_code_idx on public.garage_photos (box_code);

-- Shared settings, e.g. the household's Gemini API key.
create table if not exists public.garage_settings (
  key   text primary key,
  value text not null default ''
);

create table if not exists public.garage_counters (
  name  text primary key,
  value int not null default 0
);

-- Hands out the next unused box codes: BOX-001, BOX-002, ...
create or replace function public.garage_reserve_codes(n int)
returns text[]
language plpgsql security definer
set search_path = public
as $$
declare
  cur int;
  mx  int;
  result text[] := '{}';
begin
  if not public.garage_is_member() then
    raise exception 'Not allowed';
  end if;
  if n < 1 or n > 200 then
    raise exception 'Ask for between 1 and 200 codes';
  end if;
  insert into public.garage_counters (name, value) values ('box', 0) on conflict do nothing;
  select value into cur from public.garage_counters where name = 'box' for update;
  select coalesce(max(substring(code from '^BOX-(\d+)$')::int), 0) into mx from public.garage_boxes;
  cur := greatest(cur, mx);
  for i in 1..n loop
    cur := cur + 1;
    result := result || ('BOX-' || lpad(cur::text, greatest(3, length(cur::text)), '0'));
  end loop;
  update public.garage_counters set value = cur where name = 'box';
  return result;
end;
$$;

-- ---------- security: only household members can read or write ----------
alter table public.garage_members enable row level security;
alter table public.garage_boxes enable row level security;
alter table public.garage_photos enable row level security;
alter table public.garage_settings enable row level security;
alter table public.garage_counters enable row level security;  -- no policies: only garage_reserve_codes() touches it

drop policy if exists "garage: members see members" on public.garage_members;
create policy "garage: members see members" on public.garage_members
  for select to authenticated using (public.garage_is_member());

drop policy if exists "garage: members manage boxes" on public.garage_boxes;
create policy "garage: members manage boxes" on public.garage_boxes
  for all to authenticated using (public.garage_is_member()) with check (public.garage_is_member());

drop policy if exists "garage: members manage photos" on public.garage_photos;
create policy "garage: members manage photos" on public.garage_photos
  for all to authenticated using (public.garage_is_member()) with check (public.garage_is_member());

drop policy if exists "garage: members manage settings" on public.garage_settings;
create policy "garage: members manage settings" on public.garage_settings
  for all to authenticated using (public.garage_is_member()) with check (public.garage_is_member());

grant select on public.garage_members to authenticated;
grant select, insert, update, delete on public.garage_boxes, public.garage_photos, public.garage_settings to authenticated;
revoke all on public.garage_counters from anon, authenticated;
revoke execute on function public.garage_reserve_codes(int) from public, anon;
grant execute on function public.garage_reserve_codes(int) to authenticated;
grant execute on function public.garage_is_member() to authenticated;

-- ---------- photo storage (private bucket) ----------
insert into storage.buckets (id, name, public)
values ('garage-photos', 'garage-photos', false)
on conflict (id) do nothing;

drop policy if exists "garage: members read photos" on storage.objects;
create policy "garage: members read photos" on storage.objects
  for select to authenticated using (bucket_id = 'garage-photos' and public.garage_is_member());

drop policy if exists "garage: members add photos" on storage.objects;
create policy "garage: members add photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'garage-photos' and public.garage_is_member());

drop policy if exists "garage: members change photos" on storage.objects;
create policy "garage: members change photos" on storage.objects
  for update to authenticated using (bucket_id = 'garage-photos' and public.garage_is_member());

drop policy if exists "garage: members delete photos" on storage.objects;
create policy "garage: members delete photos" on storage.objects
  for delete to authenticated using (bucket_id = 'garage-photos' and public.garage_is_member());

-- ---------- live updates between phones ----------
do $$
begin
  alter publication supabase_realtime add table public.garage_boxes;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.garage_photos;
exception when duplicate_object then null;
end $$;

-- ---------- garage sections ----------
create table if not exists public.garage_sections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default '',
  notes       text not null default '',
  photo_path  text,
  thumb_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Each box can belong to one section. Deleting a section just un-assigns its boxes.
alter table public.garage_boxes
  add column if not exists section_id uuid references public.garage_sections(id) on delete set null;
create index if not exists garage_boxes_section_idx on public.garage_boxes (section_id);

alter table public.garage_sections enable row level security;
drop policy if exists "garage: members manage sections" on public.garage_sections;
create policy "garage: members manage sections" on public.garage_sections
  for all to authenticated using (public.garage_is_member()) with check (public.garage_is_member());
grant select, insert, update, delete on public.garage_sections to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.garage_sections;
exception when duplicate_object then null;
end $$;

-- ---------- YOUR HOUSEHOLD: change these two emails ----------
insert into public.garage_members (email) values
  ('your-email@example.com'),
  ('your-wifes-email@example.com')
on conflict do nothing;

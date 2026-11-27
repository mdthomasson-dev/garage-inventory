-- =====================================================================
-- Garage Inventory: add garage sections (run once, after setup.sql)
-- Supabase dashboard → SQL Editor → New query → paste → Run.
-- Safe to run more than once.
-- =====================================================================

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

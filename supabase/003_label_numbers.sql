-- =====================================================================
-- Garage Inventory: choose the starting number for blank labels
-- Supabase dashboard → SQL Editor → New query → paste → Run.
-- Safe to run more than once.
-- =====================================================================

-- The next box number nobody has used yet (without reserving it).
create or replace function public.garage_next_code_number()
returns int
language plpgsql stable security definer
set search_path = public
as $$
declare
  cur int;
  mx  int;
begin
  if not public.garage_is_member() then
    raise exception 'Not allowed';
  end if;
  select coalesce((select value from public.garage_counters where name = 'box'), 0) into cur;
  select coalesce(max(substring(code from '^BOX-(\d+)$')::int), 0) into mx from public.garage_boxes;
  return greatest(cur, mx) + 1;
end;
$$;

-- Marks every number up to last_number as used, so "+ New box" never reuses a printed label.
create or replace function public.garage_claim_codes_through(last_number int)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.garage_is_member() then
    raise exception 'Not allowed';
  end if;
  if last_number < 1 or last_number > 99999 then
    raise exception 'Label numbers go from 1 to 99999';
  end if;
  insert into public.garage_counters (name, value) values ('box', 0) on conflict do nothing;
  update public.garage_counters set value = greatest(value, last_number) where name = 'box';
end;
$$;

revoke execute on function public.garage_next_code_number() from public, anon;
revoke execute on function public.garage_claim_codes_through(int) from public, anon;
grant execute on function public.garage_next_code_number() to authenticated;
grant execute on function public.garage_claim_codes_through(int) to authenticated;

alter table public.cortex_profiles enable row level security;
alter table public.extraction_usage enable row level security;

drop policy if exists "Users can read own Cortex profile" on public.cortex_profiles;
drop policy if exists "Users can read own extraction usage" on public.extraction_usage;

revoke all on table public.cortex_profiles from anon;
revoke all on table public.cortex_profiles from authenticated;
revoke all on table public.extraction_usage from anon;
revoke all on table public.extraction_usage from authenticated;

revoke all on function public.ensure_cortex_profile(uuid) from public;
revoke all on function public.get_my_entitlements() from public;
revoke all on function public.increment_memory_count(uuid) from public;
revoke all on function public.consume_daily_extraction(uuid) from public;

grant execute on function public.get_my_entitlements() to authenticated;
grant execute on function public.increment_memory_count(uuid) to authenticated;
grant execute on function public.consume_daily_extraction(uuid) to service_role;

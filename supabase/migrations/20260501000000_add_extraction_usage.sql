create table if not exists public.cortex_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  memory_count integer not null default 0 check (memory_count >= 0),
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cortex_profiles enable row level security;

drop policy if exists "Users can read own Cortex profile" on public.cortex_profiles;
create policy "Users can read own Cortex profile"
on public.cortex_profiles
for select
to authenticated
using (auth.uid() = user_id);

create table if not exists public.extraction_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  count integer not null default 0 check (count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.extraction_usage enable row level security;

drop policy if exists "Users can read own extraction usage" on public.extraction_usage;
create policy "Users can read own extraction usage"
on public.extraction_usage
for select
to authenticated
using (auth.uid() = user_id);

create or replace function public.ensure_cortex_profile(p_user_id uuid)
returns public.cortex_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.cortex_profiles;
begin
  insert into public.cortex_profiles (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select *
  into v_profile
  from public.cortex_profiles
  where user_id = p_user_id;

  return v_profile;
end;
$$;

create or replace function public.get_my_entitlements()
returns table (
  plan text,
  memory_limit integer,
  daily_extraction_limit integer,
  is_paid boolean,
  memory_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.cortex_profiles;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  v_profile := public.ensure_cortex_profile(v_user_id);

  return query
  select
    v_profile.plan,
    case when v_profile.plan = 'pro' then 5000 else 200 end as memory_limit,
    case when v_profile.plan = 'pro' then 500 else 10 end as daily_extraction_limit,
    v_profile.plan <> 'free' as is_paid,
    v_profile.memory_count;
end;
$$;

create or replace function public.increment_memory_count(user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or auth.uid() <> $1 then
    raise exception 'Authentication required';
  end if;

  perform public.ensure_cortex_profile($1);

  update public.cortex_profiles
  set memory_count = memory_count + 1,
      updated_at = now()
  where cortex_profiles.user_id = $1
  returning memory_count into v_count;

  return v_count;
end;
$$;

create or replace function public.consume_daily_extraction(
  p_user_id uuid
)
returns table (
  allowed boolean,
  used integer,
  daily_limit integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := current_date;
  v_reset_at timestamptz := (current_date + interval '1 day')::timestamptz;
  v_profile public.cortex_profiles;
  v_limit integer;
begin
  v_profile := public.ensure_cortex_profile(p_user_id);
  v_limit := case when v_profile.plan = 'pro' then 500 else 10 end;

  insert into public.extraction_usage as usage (
    user_id,
    usage_date,
    count,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    v_today,
    1,
    now(),
    now()
  )
  on conflict (user_id, usage_date)
  do update
    set count = usage.count + 1,
        updated_at = now()
    where usage.count < v_limit
  returning true, count, v_limit, v_reset_at
  into allowed, used, daily_limit, reset_at;

  if allowed is null then
    select
      false,
      usage.count,
      v_limit,
      v_reset_at
    into allowed, used, daily_limit, reset_at
    from public.extraction_usage as usage
    where usage.user_id = p_user_id
      and usage.usage_date = v_today;
  end if;

  return next;
end;
$$;

revoke all on function public.ensure_cortex_profile(uuid) from public;
revoke all on function public.get_my_entitlements() from public;
revoke all on function public.increment_memory_count(uuid) from public;
revoke all on function public.consume_daily_extraction(uuid) from public;

grant execute on function public.get_my_entitlements() to authenticated;
grant execute on function public.increment_memory_count(uuid) to authenticated;
grant execute on function public.consume_daily_extraction(uuid) to service_role;

alter table public.cortex_profiles
  add column if not exists billing_provider text,
  add column if not exists lemon_customer_id text,
  add column if not exists lemon_subscription_id text,
  add column if not exists lemon_order_id text,
  add column if not exists customer_portal_url text;

create index if not exists cortex_profiles_lemon_customer_id_idx
on public.cortex_profiles (lemon_customer_id);

create index if not exists cortex_profiles_lemon_subscription_id_idx
on public.cortex_profiles (lemon_subscription_id);

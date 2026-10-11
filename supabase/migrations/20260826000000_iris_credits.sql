-- IrisCAD owns its own usage balance. One Credit maps to US$0.01 of measured
-- inference cost in the application server; it is not a provider-native token.

create table if not exists public.iris_credit_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 300 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.iris_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null check (delta <> 0),
  operation text not null,
  reference_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists iris_credit_transactions_reference_once
  on public.iris_credit_transactions (user_id, operation, reference_id)
  where reference_id is not null;

alter table public.iris_credit_accounts enable row level security;
alter table public.iris_credit_transactions enable row level security;

create policy "Users can read their Iris Credit balance"
  on public.iris_credit_accounts for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can read their Iris Credit history"
  on public.iris_credit_transactions for select
  to authenticated
  using (auth.uid() = user_id);

-- Give every existing account the same launch balance exactly once.
insert into public.iris_credit_accounts (user_id, balance)
select id, 300
from auth.users
on conflict (user_id) do nothing;

-- New email and OAuth users receive their launch balance in the same trigger
-- that creates their profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (user_id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );

  insert into public.iris_credit_accounts (user_id, balance)
  values (new.id, 300)
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

create or replace function public.consume_iris_credits(
  p_user_id uuid,
  p_credits integer,
  p_operation text,
  p_reference_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (ok boolean, credits_deducted integer, credits_available integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_balance integer;
  v_deducted integer;
  v_existing_delta integer;
begin
  if p_credits <= 0 then
    select balance into v_balance
    from public.iris_credit_accounts
    where user_id = p_user_id;
    return query select true, 0, coalesce(v_balance, 0);
    return;
  end if;

  -- A stream can retry its finish handler; a reference must never charge twice.
  if p_reference_id is not null then
    select delta into v_existing_delta
    from public.iris_credit_transactions
    where user_id = p_user_id
      and operation = p_operation
      and reference_id = p_reference_id;
    if found then
      select balance into v_balance
      from public.iris_credit_accounts
      where user_id = p_user_id;
      return query select true, greatest(-v_existing_delta, 0), coalesce(v_balance, 0);
      return;
    end if;
  end if;

  insert into public.iris_credit_accounts (user_id, balance)
  values (p_user_id, 300)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.iris_credit_accounts
  where user_id = p_user_id
  for update;

  v_deducted := least(v_balance, p_credits);
  update public.iris_credit_accounts
  set balance = v_balance - v_deducted,
      updated_at = now()
  where user_id = p_user_id
  returning balance into v_balance;

  if v_deducted > 0 then
    insert into public.iris_credit_transactions
      (user_id, delta, operation, reference_id, metadata)
    values
      (p_user_id, -v_deducted, p_operation, p_reference_id, coalesce(p_metadata, '{}'::jsonb));
  end if;

  return query select v_deducted > 0, v_deducted, v_balance;
end;
$function$;

create or replace function public.refund_iris_credits(
  p_user_id uuid,
  p_credits integer,
  p_operation text,
  p_reference_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (credits_refunded integer, credits_available integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_balance integer;
begin
  if p_credits <= 0 then
    return query select 0, 0;
    return;
  end if;

  if p_reference_id is not null and exists (
    select 1 from public.iris_credit_transactions
    where user_id = p_user_id and operation = p_operation and reference_id = p_reference_id
  ) then
    select balance into v_balance from public.iris_credit_accounts where user_id = p_user_id;
    return query select 0, coalesce(v_balance, 0);
    return;
  end if;

  insert into public.iris_credit_accounts (user_id, balance)
  values (p_user_id, 300)
  on conflict (user_id) do nothing;

  update public.iris_credit_accounts
  set balance = balance + p_credits,
      updated_at = now()
  where user_id = p_user_id
  returning balance into v_balance;

  insert into public.iris_credit_transactions
    (user_id, delta, operation, reference_id, metadata)
  values
    (p_user_id, p_credits, p_operation, p_reference_id, coalesce(p_metadata, '{}'::jsonb));

  return query select p_credits, v_balance;
end;
$function$;

revoke all on function public.consume_iris_credits(uuid, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.refund_iris_credits(uuid, integer, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.consume_iris_credits(uuid, integer, text, text, jsonb) to service_role;
grant execute on function public.refund_iris_credits(uuid, integer, text, text, jsonb) to service_role;

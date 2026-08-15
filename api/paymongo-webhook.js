-- =============================================================================
-- supabase-activate-subscription.sql
-- =============================================================================
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query → paste → Run.
--
-- This is what api/paymongo-webhook.js calls the instant PayMongo confirms a
-- payment. It mirrors what markSubscriptionActive() does on the client, but
-- runs server-side, triggered automatically by PayMongo — not by the
-- subscriber clicking anything.
--
-- SECURITY: this function can flip any account straight to "active" with no
-- payment check of its own — the webhook's signature verification is what
-- makes sure it's only ever called after a REAL confirmed payment. Because
-- of that, this function must NEVER be callable from the browser (with the
-- public anon key) or by a logged-in user calling it on themselves — only
-- the webhook, authenticating with your SERVICE ROLE key, is allowed to
-- call it. The revokes near the bottom of this script are what enforce that.

drop function if exists public.finalize_referral_redemption_for(uuid) cascade;
create or replace function public.finalize_referral_redemption_for(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
-- Same logic as finalize_referral_redemption() in your main setup script,
-- just parameterized by an explicit business id instead of auth.uid() —
-- the webhook has no logged-in session, so it can't rely on auth.uid().
declare
  v_caller_email text;
  v_pending_code text;
  v_referred_by uuid;
  v_already_granted boolean;
  v_referrer_id uuid;
  v_referrer_email text;
  v_referrer_status text;
  v_referrer_period_end timestamptz;
  v_referrer_is_eligible boolean;
begin
  select email, pending_referral_code, referred_by, coalesce(referral_reward_granted, false)
    into v_caller_email, v_pending_code, v_referred_by, v_already_granted
    from public.businesses
    where id = p_business_id;

  if v_pending_code is not null and v_referred_by is null then
    select id, email
      into v_referrer_id, v_referrer_email
      from public.businesses
      where upper(referral_code) = v_pending_code;

    if v_referrer_id is null
       or v_referrer_id = p_business_id
       or (v_referrer_email is not null and v_caller_email is not null
           and lower(v_referrer_email) = lower(v_caller_email)) then
      update public.businesses set pending_referral_code = null where id = p_business_id;
    elsif v_caller_email is not null and exists (
      select 1 from public.referral_redemptions
      where lower(email) = lower(v_caller_email)
        and upper(code) = v_pending_code
    ) then
      update public.businesses set pending_referral_code = null where id = p_business_id;
    else
      insert into public.referral_redemptions (email, code)
        values (v_caller_email, v_pending_code);

      update public.businesses
        set referred_by = v_referrer_id, pending_referral_code = null
        where id = p_business_id;

      update public.businesses
        set referral_count = coalesce(referral_count, 0) + 1
        where id = v_referrer_id;

      v_referred_by := v_referrer_id;
    end if;
  end if;

  if v_referred_by is null or v_already_granted then
    return;
  end if;

  select subscription_status, subscription_period_end
    into v_referrer_status, v_referrer_period_end
    from public.businesses
    where id = v_referred_by;

  v_referrer_is_eligible := (v_referrer_status = 'active')
    and (v_referrer_period_end is null or v_referrer_period_end > now());

  if v_referrer_is_eligible then
    update public.businesses
      set reward_credits = coalesce(reward_credits, 0) + 3
      where id = v_referred_by;
  end if;

  update public.businesses
    set referral_reward_granted = true
    where id = p_business_id;
end;
$$;

drop function if exists public.activate_subscription_for_business(uuid, text) cascade;
create or replace function public.activate_subscription_for_business(
  p_business_id uuid,
  p_reference text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_first_payment boolean;
  v_period_end timestamptz := now() + interval '30 days';
  v_exists boolean;
begin
  select exists(select 1 from public.businesses where id = p_business_id)
    into v_exists;
  if not v_exists then
    raise exception 'No business found with id %', p_business_id;
  end if;

  select subscription_status is distinct from 'active'
    into v_is_first_payment
    from public.businesses
    where id = p_business_id;

  update public.businesses
    set subscription_status = 'active',
        subscription_period_end = v_period_end,
        payment_reference = coalesce(p_reference, payment_reference),
        reward_credits = 0,
        discount_percent = case when v_is_first_payment then 0 else discount_percent end
    where id = p_business_id;

  if v_is_first_payment then
    perform public.finalize_referral_redemption_for(p_business_id);
  end if;
end;
$$;

-- ---- Lock both functions down to server-side (webhook) use only ----
-- By default Postgres grants EXECUTE to PUBLIC, which in Supabase means the
-- browser's anon key AND any logged-in user could otherwise call these and
-- activate an account with no payment at all. Revoke that, then grant
-- execute ONLY to service_role (the role your webhook authenticates as via
-- SUPABASE_SERVICE_ROLE_KEY — never exposed to the browser).
revoke execute on function public.activate_subscription_for_business(uuid, text) from public;
revoke execute on function public.activate_subscription_for_business(uuid, text) from anon;
revoke execute on function public.activate_subscription_for_business(uuid, text) from authenticated;
grant execute on function public.activate_subscription_for_business(uuid, text) to service_role;

revoke execute on function public.finalize_referral_redemption_for(uuid) from public;
revoke execute on function public.finalize_referral_redemption_for(uuid) from anon;
revoke execute on function public.finalize_referral_redemption_for(uuid) from authenticated;
grant execute on function public.finalize_referral_redemption_for(uuid) to service_role;

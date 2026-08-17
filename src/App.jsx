/* =============================================================================
   ONE-TIME SUPABASE SETUP — run this once, then ignore it forever
   =============================================================================
   This app needs a few small database functions/columns to exist in your
   Supabase project before "Delete account" and the referral program will
   work correctly.

   WHY THIS CAN'T LIVE INSIDE THE APP ITSELF:
   The public API key shipped in this file (see SUPABASE_ANON_KEY below) is
   deliberately powerless to delete a login/auth user directly, or to hand
   out discounts to itself — if it could, anyone could delete anyone's
   account, or write themselves a 100% coupon from the browser console. The
   only safe way to allow "delete my own account" or "redeem this referral
   code" is a database function that runs with elevated privileges but is
   hard-coded to only ever do the one safe thing it's meant to do. That
   function has to be created inside Supabase itself, not shipped as browser
   code, the same way you'd never ship a database password to the browser.
   So: one copy-paste, one time, in a different place than this file.

   HOW TO RUN IT:
   1. Open your project at https://supabase.com/dashboard
   2. Left sidebar → SQL Editor → "New query"
   3. Paste everything between the START/END markers below
   4. Click "Run"
   You only ever have to do this once per Supabase project. If you ever
   change REFERRAL_DISCOUNT_PERCENT or REFERRAL_REWARD_PERCENT below, update
   the matching numbers in this SQL too (they're intentionally hard-coded on
   the server, not read from the client, so the browser can't fake them).

   ---- START: paste into Supabase SQL Editor ----

   drop function if exists delete_own_account() cascade;
   create or replace function delete_own_account()
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     -- Remove their business profile row first.
     delete from public.businesses where id = auth.uid();

     -- Then remove their actual login/auth user.
     delete from auth.users where id = auth.uid();
   end;
   $$;

   -- Let any logged-in user call it (it can still only affect their own row).
   grant execute on function delete_own_account() to authenticated;

   -- Tracks when the current paid period ends, so the app knows when a
   -- renewal (not just the free trial) is due. Safe to run even if this
   -- column already exists.
   alter table public.businesses
     add column if not exists subscription_period_end timestamptz;

   -- The account's permanent billing/display currency, chosen once at
   -- sign-up (see SignUpView) and never changed afterward. Having this on
   -- the server (not just in this device's local storage) means the
   -- currency travels with the account to a new device/browser instead of
   -- silently resetting to PHP. Safe to run even if this column already
   -- exists.
   alter table public.businesses
     add column if not exists currency_code text default 'PHP';

   -- THIS IS THE PIECE THAT WAS MISSING: nothing in this project ever
   -- actually WROTE a referral_code onto a business row — the app and the
   -- redeem_referral() function below only ever READ it. So if you flip an
   -- account to "active" (in the app, or by hand in the Supabase table
   -- editor) but its referral_code is still null, the Settings page has
   -- nothing to show, even though the account is correctly subscribed.
   -- This trigger auto-generates a short, unique, uppercase code the
   -- moment a business row is created, so every account gets one
   -- automatically going forward — the code exists from day one, it's just
   -- kept hidden in the UI (see SettingsView's isSubscriber check) until
   -- the account actually subscribes.
   --
   -- The DROP first is needed because Postgres refuses to change an
   -- existing function's return type via CREATE OR REPLACE (error 42P13)
   -- — it can only be dropped and recreated. Harmless if this function
   -- doesn't exist yet; CASCADE also drops the trg_set_referral_code
   -- trigger below if it already exists, which gets recreated further
   -- down in this same script anyway.
   drop function if exists generate_referral_code() cascade;
   create or replace function generate_referral_code()
   returns text
   language plpgsql
   as $$
   declare
     v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ'; -- no I/O, avoids confusing codes
     v_digits text := '23456789'; -- no 0/1, avoids confusing codes
     v_chars text := v_letters || v_digits;
     v_code text;
     v_has_letter boolean;
     v_has_digit boolean;
     v_c text;
   begin
     loop
       v_code := '';
       v_has_letter := false;
       v_has_digit := false;
       for i in 1..6 loop
         v_c := substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
         v_code := v_code || v_c;
         if strpos(v_letters, v_c) > 0 then
           v_has_letter := true;
         else
           v_has_digit := true;
         end if;
       end loop;
       -- Every code is guaranteed to mix at least one letter AND one digit
       -- (not left to pure chance) — reroll all 6 characters until both
       -- are present, so a code never comes out as, say, all letters.
       exit when v_has_letter and v_has_digit and not exists(
         select 1 from public.businesses where referral_code = v_code
       );
     end loop;
     return v_code;
   end;
   $$;

   drop function if exists set_referral_code_on_insert() cascade;
   create or replace function set_referral_code_on_insert()
   returns trigger
   language plpgsql
   as $$
   begin
     if new.referral_code is null then
       new.referral_code := generate_referral_code();
     end if;
     return new;
   end;
   $$;

   drop trigger if exists trg_set_referral_code on public.businesses;
   create trigger trg_set_referral_code
     before insert on public.businesses
     for each row
     execute function set_referral_code_on_insert();

   -- ONE-TIME BACKFILL: run this once so any account created BEFORE this
   -- trigger existed (including one you've already flipped to "active" by
   -- hand) gets a code retroactively too. Safe to re-run — it only touches
   -- rows that still have a null referral_code.
   update public.businesses
     set referral_code = generate_referral_code()
     where referral_code is null;

   -- Holds a referral code the caller has TYPED AND CLICKED APPLY ON, but
   -- hasn't paid for yet. Nothing about a code is permanent (not the
   -- referrer's count, not the redemption record) until the caller's FIRST
   -- payment is actually confirmed — see finalize_referral_redemption()
   -- below. Until then this is just a "what code is currently queued up"
   -- pointer, and applying a code (or a different code) can be done as many
   -- times as the caller likes with zero side effects on the referrer. Safe
   -- to run even if this column already exists.
   alter table public.businesses
     add column if not exists pending_referral_code text;

   -- Applies a referral/discount code the caller typed in: shows them the
   -- 25% first-payment price immediately (good UX — they should see the
   -- discounted price before paying), but does NOT yet touch anything
   -- permanent. Previously this function committed the redemption the
   -- instant "Apply" was clicked — writing referred_by, inserting into
   -- referral_redemptions, and incrementing the referrer's referral_count
   -- — all before the caller had paid a cent. That meant someone who
   -- clicked Apply and then closed the tab without paying had already
   -- "used" the code: referred_by was set, which made every later attempt
   -- (by them, including a genuine retry) fail with "You've already
   -- redeemed a referral code", even though no discount had actually been
   -- honored yet. Now, applying a code only ever sets discount_percent (for
   -- the price preview) and pending_referral_code (a note of which code is
   -- queued up) — both freely overwritable, right up until the caller's
   -- first payment is confirmed. The code is only actually "spent" — for
   -- both the caller and the referrer — by finalize_referral_redemption()
   -- below, which the app calls the moment payment is confirmed (see
   -- markSubscriptionActive() in the app code). If the caller never pays,
   -- nothing here was ever permanent: the same code (or a different one)
   -- can be applied again later with no penalty.
   -- Guards against every way someone could try to farm their own code:
   --   - can't redeem your own code (by account id)
   --   - can't redeem a code whose owner shares your account's email either
   --     (belt-and-suspenders — Supabase Auth already blocks duplicate
   --     emails, so this mainly catches a business row whose email field
   --     drifted out of sync with its auth email)
   --   - can only be redeemed once per account, ever — but that "once" is
   --     now measured by an actual completed, PAID redemption (referred_by
   --     being set by finalize_referral_redemption() below), not by merely
   --     having clicked Apply
   --   - can't redeem the SAME code with the SAME email twice, even across
   --     deleting and recreating the account — this is enforced
   --     permanently via referral_redemptions (see above), which is never
   --     touched by delete_own_account(). A different code, or a genuinely
   --     different email, isn't blocked by this. This check only looks at
   --     COMPLETED redemptions, so it never blocks re-applying a code you
   --     applied but never paid for.
   --   - can only be applied before your FIRST payment — it's a new-signup
   --     perk, not something you can retroactively apply once you're an
   --     active subscriber
   -- Tracks every (email, code) redemption PERMANENTLY — deliberately its
   -- own table, not a column on `businesses`, so this survives account
   -- deletion. Without this, deleting your account (see
   -- delete_own_account() above) and signing back up with the SAME email
   -- would let you redeem the SAME referral code a second time, since the
   -- only record of "this email already used this code" used to live on
   -- the (now-deleted) businesses row. This table is keyed on email+code
   -- specifically, not just email — a given email is blocked from reusing
   -- a code it's already completed a paid redemption with, but is free to
   -- apply a DIFFERENT code later (see redeem_referral() below, which
   -- checks this table, and finalize_referral_redemption() below, which
   -- writes to it).
   create table if not exists public.referral_redemptions (
     id bigserial primary key,
     email text not null,
     code text not null,
     redeemed_at timestamptz not null default now()
   );

   -- One (email, code) combination can only ever be redeemed once, for the
   -- lifetime of that email address — enforced case-insensitively so
   -- "Owner@X.com"/"owner@x.com" and "abcd"/"ABCD" can't slip past it.
   create unique index if not exists referral_redemptions_email_code_idx
     on public.referral_redemptions (lower(email), upper(code));

   -- No direct grants for this table — it's only ever touched from inside
   -- redeem_referral() and finalize_referral_redemption() below, both of
   -- which run as SECURITY DEFINER. RLS is enabled with no policies, so
   -- nothing can read or write it directly (including the browser's anon
   -- key); only those SECURITY DEFINER functions can.
   alter table public.referral_redemptions enable row level security;

   drop function if exists redeem_referral(text) cascade;
   create or replace function redeem_referral(p_code text)
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
   declare
     v_caller_id uuid := auth.uid();
     v_caller_email text;
     v_caller_status text;
     v_caller_referred_by uuid;
     v_referrer_id uuid;
     v_referrer_email text;
   begin
     if v_caller_id is null then
       raise exception 'You must be logged in to redeem a referral code.';
     end if;

     select email, subscription_status, referred_by
       into v_caller_email, v_caller_status, v_caller_referred_by
       from public.businesses
       where id = v_caller_id;

     -- Fallback: some accounts (e.g. rows created or edited by hand in the
     -- Supabase Table Editor rather than through normal sign-up) can end
     -- up with a null email on their businesses row, even though every
     -- real Supabase Auth user always has one. Without this fallback, the
     -- referral_redemptions insert made later by finalize_referral_redemption()
     -- fails with a generic "null value in column email violates not-null
     -- constraint" instead of a clear, actionable message — and worse,
     -- silently skips recording the redemption at all. Pull it from
     -- auth.users as a backstop so this only ever fails with the explicit
     -- exception below, if it's truly unknown everywhere.
     if v_caller_email is null then
       select email into v_caller_email from auth.users where id = v_caller_id;
       -- Quietly repair the businesses row now that we know the real
       -- email, so this fallback doesn't need to run again for this
       -- account next time.
       if v_caller_email is not null then
         update public.businesses set email = v_caller_email where id = v_caller_id;
       end if;
     end if;

     if v_caller_email is null then
       raise exception 'Your account is missing an email address, so a referral code can''t be recorded. Contact support to fix this.';
     end if;

     if v_caller_status = 'active' then
       raise exception 'Referral codes can only be used before your first payment.';
     end if;

     -- referred_by is only ever set by finalize_referral_redemption() below,
     -- once a payment actually clears — so this only blocks someone who has
     -- already completed one paid referral discount before. Merely having
     -- applied-but-not-paid a code before does NOT set referred_by, so it
     -- never blocks a genuine retry or a switch to a different code.
     if v_caller_referred_by is not null then
       raise exception 'You''ve already redeemed a referral code.';
     end if;

     -- Permanent, email-scoped re-use check — this is what actually
     -- survives account deletion (see referral_redemptions above). Blocks
     -- this exact (email, code) pair only, and only once that pair has
     -- actually completed a paid redemption via finalize_referral_redemption()
     -- below; the same email can still apply a DIFFERENT code, or retry
     -- this same code, any time before paying.
     if v_caller_email is not null and exists (
       select 1 from public.referral_redemptions
       where lower(email) = lower(v_caller_email)
         and upper(code) = upper(trim(p_code))
     ) then
       raise exception 'This code has already been used for this email. Use another code.';
     end if;

     select id, email
       into v_referrer_id, v_referrer_email
       from public.businesses
       where upper(referral_code) = upper(trim(p_code));

     if v_referrer_id is null then
       raise exception 'Invalid referral code.';
     end if;

     if v_referrer_id = v_caller_id
        or (v_referrer_email is not null and v_caller_email is not null
            and lower(v_referrer_email) = lower(v_caller_email)) then
       raise exception 'You can''t use your own referral code.';
     end if;

     -- Nothing permanent yet: just the price-preview discount and a note of
     -- which code is queued up. referred_by, the referral_redemptions row,
     -- and the referrer's referral_count are all written later, only once
     -- this payment is actually confirmed — see finalize_referral_redemption()
     -- below. That's what lets this same code (or a different one) be
     -- applied again with zero penalty if the caller never ends up paying.
     update public.businesses
       set discount_percent = 25, pending_referral_code = upper(trim(p_code))
       where id = v_caller_id;
   end;
   $$;

   grant execute on function redeem_referral(text) to authenticated;

   -- Actually "spends" a referral code — called from the app the moment the
   -- caller's FIRST payment is confirmed (see markSubscriptionActive() in
   -- the app code), never at code-apply time. This is the ONLY place a code
   -- is ever marked used: it's what writes the permanent
   -- referral_redemptions row, sets referred_by, and bumps the referrer's
   -- referral_count — so someone who clicked Apply and then never paid
   -- never counts as having "used" a code at all, for either side.
   --
   -- Also grants the referrer their one-time 3% reward credit for having
   -- referred the caller — but ONLY the first time this runs for a given
   -- caller, and ONLY if the caller actually has a code queued up or
   -- already finalized. This is what makes the reward reflect a real
   -- paying referral instead of just someone typing in a code and
   -- abandoning the upgrade screen.
   --
   -- Guards against ever double-crediting or double-counting the same
   -- referral:
   --   - referral_reward_granted on the CALLER's row flips to true the
   --     first time this runs for them and is checked up front, so a
   --     second call (e.g. a renewal, or the confirm button being pressed
   --     twice) is a safe no-op.
   --   - pending_referral_code is cleared the moment it's finalized (or
   --     found unusable), so it's never finalized twice.
   --   - the same permanent referral_redemptions uniqueness redeem_referral()
   --     checks before allowing an apply is re-checked here too, so a race
   --     between two tabs both applying-then-paying can't double-insert.
   -- Mirrors the same subscriber-only eligibility redeem_referral() checks:
   -- the referrer only actually receives the 3% if THEY are currently an
   -- active, non-lapsed subscriber at the moment their referral pays — if
   -- not, the referral still gets marked as "granted" (so it's never
   -- retried later once the referrer's status changes), it just doesn't
   -- add any credit.
   drop function if exists grant_referral_reward_on_payment() cascade;
   drop function if exists finalize_referral_redemption() cascade;
   create or replace function finalize_referral_redemption()
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
   declare
     v_caller_id uuid := auth.uid();
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
     if v_caller_id is null then
       return;
     end if;

     select email, pending_referral_code, referred_by, coalesce(referral_reward_granted, false)
       into v_caller_email, v_pending_code, v_referred_by, v_already_granted
       from public.businesses
       where id = v_caller_id;

     -- A code was applied but never finalized before — spend it now, for
     -- real, since this is the first confirmed payment. Only runs if
     -- referred_by isn't already set (i.e. this hasn't been finalized
     -- before), so it can never run twice for the same code.
     if v_pending_code is not null and v_referred_by is null then
       select id, email
         into v_referrer_id, v_referrer_email
         from public.businesses
         where upper(referral_code) = v_pending_code;

       -- The code's owner account is gone or the code changed somehow
       -- between apply-time and now — nothing to credit, just clear the
       -- stale pointer and move on with the payment.
       if v_referrer_id is null
          or v_referrer_id = v_caller_id
          or (v_referrer_email is not null and v_caller_email is not null
              and lower(v_referrer_email) = lower(v_caller_email)) then
         update public.businesses set pending_referral_code = null where id = v_caller_id;
       elsif v_caller_email is not null and exists (
         select 1 from public.referral_redemptions
         where lower(email) = lower(v_caller_email)
           and upper(code) = v_pending_code
       ) then
         -- Already recorded by a previous call (e.g. a duplicate click) —
         -- just clear the pointer, don't insert a second row.
         update public.businesses set pending_referral_code = null where id = v_caller_id;
       else
         insert into public.referral_redemptions (email, code)
           values (v_caller_email, v_pending_code);

         update public.businesses
           set referred_by = v_referrer_id, pending_referral_code = null
           where id = v_caller_id;

         -- Referral count is a stat, safe to count now that the referral
         -- has genuinely resulted in a paid subscription.
         update public.businesses
           set referral_count = coalesce(referral_count, 0) + 1
           where id = v_referrer_id;

         v_referred_by := v_referrer_id;
       end if;
     end if;

     -- Nothing to reward: this account was never referred (no code was
     -- ever applied, or it turned out unusable above), or this exact
     -- referral has already been credited once before.
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
       -- Capped at 50 so accumulation genuinely stops once a referrer hits
       -- the maximum discount for the month — matches MAX_REWARD_CREDIT_PERCENT
       -- in the app code (cafe-pos.jsx). If you ever change that constant,
       -- change the 50 here (and in the other identical UPDATE below) to
       -- match, or the two will drift out of sync.
       update public.businesses
         set reward_credits = least(coalesce(reward_credits, 0) + 3, 50)
         where id = v_referred_by;
     end if;

     -- Marked granted regardless of the eligibility outcome above, so this
     -- referral is never re-evaluated or re-credited again later — it's a
     -- one-time perk tied to this one first payment, not something that
     -- keeps checking back in on the referrer's status.
     update public.businesses
       set referral_reward_granted = true
       where id = v_caller_id;
   end;
   $$;

   grant execute on function finalize_referral_redemption() to authenticated;

   -- Tracks whether THIS account's referral reward (the 3% it owes its
   -- referrer) has already been granted, so finalize_referral_redemption()
   -- above can never fire twice for the same referral. Safe to run even if
   -- this column already exists.
   alter table public.businesses
     add column if not exists referral_reward_granted boolean not null default false;

   -- FIX: some signups ended up with an auth.users account but NO row in
   -- businesses at all (Settings showed blank Business name / Email because
   -- there was nothing to read). Root cause: the ONLY thing that ever
   -- created a businesses row was the client-side insert()/upsert() call in
   -- signUp() below. If there's no active session at that exact moment —
   -- e.g. "Confirm email" is ON in Authentication -> Providers -> Email, so
   -- signUp() returns a user but no session until they click the
   -- confirmation link — that call runs unauthenticated and Row Level
   -- Security silently blocks it. This trigger creates the row on the
   -- SERVER instead, the moment ANY new auth.users row is created, via
   -- SECURITY DEFINER — so it works regardless of session/RLS state.
   -- business_name and currency_code come from the signup metadata (see
   -- `options: { data: {...} }` on the supabase.auth.signUp() call below).
   drop function if exists public.handle_new_user() cascade;
   create or replace function public.handle_new_user()
   returns trigger
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     insert into public.businesses (id, business_name, email, trial_start_date, currency_code)
     values (
       new.id,
       coalesce(new.raw_user_meta_data->>'business_name', ''),
       new.email,
       now(),
       coalesce(new.raw_user_meta_data->>'currency_code', 'PHP')
     )
     on conflict (id) do nothing;
     return new;
   end;
   $$;

   drop trigger if exists on_auth_user_created on auth.users;
   create trigger on_auth_user_created
     after insert on auth.users
     for each row execute function public.handle_new_user();

   -- ONE-TIME BACKFILL: repairs any EXISTING auth.users account that's
   -- missing a businesses row. business_name is left blank (fill it back in
   -- from Settings); currency_code defaults to PHP; trial_start_date is set
   -- to right now so affected accounts get a fresh full trial. Safe to
   -- re-run — only touches accounts still missing a row.
   insert into public.businesses (id, business_name, email, trial_start_date, currency_code)
   select u.id, '', u.email, now(), 'PHP'
   from auth.users u
   left join public.businesses b on b.id = u.id
   where b.id is null;

   ---- END: paste into Supabase SQL Editor ----
   ============================================================================= */

/* =============================================================================
   OPTIONAL — EMAIL NOTIFICATIONS SETUP (run once, separately from the block
   above)
   =============================================================================
   Sends YOU an email the moment something business-relevant happens: a new
   sign-up, a first-time subscription, a renewal, a referral code being used,
   or an account being deleted. This has to run on the SERVER (a database
   trigger), not in this file's browser code — the browser's key is
   deliberately powerless to do anything as sensitive as sending email on
   your behalf, the same reason it can't delete accounts or grant discounts
   (see the block above).

   HOW TO SET THIS UP (about 5 minutes, no coding):
     1. Go to https://resend.com and create a free account.
     2. In Resend, click "API Keys" in the left sidebar -> "Create API Key".
        Copy the key it gives you (starts with "re_").
     3. On Resend's free plan, you can only send emails TO the address you
        signed up to Resend with (until you verify a domain). So sign up to
        Resend using the inbox you actually want notifications in.
     4. Copy everything between the START/END markers below into a NEW query
        in Supabase's SQL Editor (same place as the block above).
     5. In that pasted text (inside the SQL Editor, NOT in this file),
        replace REPLACE_WITH_YOUR_RESEND_API_KEY with the key from step 2,
        and REPLACE_WITH_YOUR_EMAIL with the inbox from step 3.
     6. Click "Run".

   IMPORTANT — KEEP THIS KEY PRIVATE: unlike the SUPABASE_ANON_KEY used
   elsewhere in this file (which is safe to be public), your Resend API key
   can send email as you and must stay secret. Only paste it into Supabase's
   SQL Editor — never paste the real key back into this .jsx file, and never
   share this file (or a screenshot of the SQL Editor with the key visible)
   publicly once you've filled it in. If you ever need to invalidate it,
   just delete the key in Resend and create a new one, then re-run the block
   below with the new value.

   ---- START: paste into Supabase SQL Editor (as a separate query) ----

   -- Lets the database make outgoing web requests (needed to call Resend).
   create extension if not exists pg_net with schema extensions;

   -- One shared helper: every notification below just calls this with a
   -- subject and an HTML body. Keeping the Resend call in one place means
   -- the API key only has to be pasted in once, not once per event.
   create or replace function public.notify_owner(p_subject text, p_html text)
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     perform net.http_post(
       url := 'https://api.resend.com/emails',
       headers := jsonb_build_object(
         'Authorization', 'Bearer REPLACE_WITH_YOUR_RESEND_API_KEY',
         'Content-Type', 'application/json'
       ),
       body := jsonb_build_object(
         'from', 'OpSteward Alerts <onboarding@resend.dev>',
         'to', jsonb_build_array('REPLACE_WITH_YOUR_EMAIL'),
         'subject', p_subject,
         'html', p_html
       )
     );
   end;
   $$;

   -- 1) NEW SIGN-UP — fires the instant a new businesses row is created,
   -- which covers both a normal sign-up and the handle_new_user() trigger
   -- fallback above, so it can never be missed either way.
   drop function if exists public.notify_on_signup() cascade;
   create or replace function public.notify_on_signup()
   returns trigger
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     perform public.notify_owner(
       '🎉 New sign-up: ' || coalesce(nullif(new.business_name, ''), new.email, 'someone'),
       '<p>A new account just signed up.</p>' ||
       '<p><b>Business:</b> ' || coalesce(nullif(new.business_name, ''), '(not set yet)') || '<br>' ||
       '<b>Email:</b> ' || coalesce(new.email, '(unknown)') || '</p>'
     );
     return new;
   end;
   $$;

   drop trigger if exists trg_notify_on_signup on public.businesses;
   create trigger trg_notify_on_signup
     after insert on public.businesses
     for each row execute function public.notify_on_signup();

   -- 2) FIRST SUBSCRIPTION vs RENEWAL vs REFERRAL USED — all three are just
   -- different kinds of UPDATE on the same businesses row, so one trigger
   -- covers them. Distinguishes a first payment (subscription_status was NOT
   -- already 'active') from a renewal (it already was, and the paid period
   -- just moved forward) — matches exactly how markSubscriptionActive() in
   -- the app itself tells the two apart.
   drop function if exists public.notify_on_subscription_change() cascade;
   create or replace function public.notify_on_subscription_change()
   returns trigger
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     if new.subscription_status = 'active' and old.subscription_status is distinct from 'active' then
       perform public.notify_owner(
         '💰 New subscriber: ' || coalesce(nullif(new.business_name, ''), new.email, 'someone'),
         '<p><b>' || coalesce(nullif(new.business_name, ''), new.email, 'A business') || '</b> just subscribed for the first time.</p>'
       );
     elsif new.subscription_status = 'active' and old.subscription_status = 'active'
       and new.subscription_period_end is distinct from old.subscription_period_end then
       perform public.notify_owner(
         '🔁 Renewal: ' || coalesce(nullif(new.business_name, ''), new.email, 'someone'),
         '<p><b>' || coalesce(nullif(new.business_name, ''), new.email, 'A business') || '</b> just renewed their subscription.</p>'
       );
     end if;

     if coalesce(new.referral_count, 0) > coalesce(old.referral_count, 0) then
       perform public.notify_owner(
         '🤝 Referral code used: ' || coalesce(nullif(new.business_name, ''), new.email, 'someone'),
         '<p><b>' || coalesce(nullif(new.business_name, ''), new.email, 'A business') || '</b>''s referral code was just used by a new paying subscriber.</p>'
       );
     end if;

     return new;
   end;
   $$;

   drop trigger if exists trg_notify_on_subscription_change on public.businesses;
   create trigger trg_notify_on_subscription_change
 

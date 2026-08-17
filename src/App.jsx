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
   --   - can't redeem your own code (by account id)
   --   - can't redeem a code whose owner shares your account's email either
   --     (belt-and-suspenders — Supabase Auth already blocks duplicate
   --     emails, so this mainly catches a business row whose email field
   --     drifted out of sync with its auth email)
   --   - can only be redeemed once per account, ever — but that "once" is
   --     now measured by an actual completed, PAID redemption (referred_by
   --     being set by finalize_referral_redemption() below), not by merely
   --     having clicked Apply
   --   - can't redeem the SAME code with the SAME email twice, even across
   --     deleting and recreating the account — this is enforced
   --     permanently via referral_redemptions (see above), which is never
   --     touched by delete_own_account(). A different code, or a genuinely
   --     different email, isn't blocked by this. This check only looks at
   --     COMPLETED redemptions, so it never blocks re-applying a code you
   --     applied but never paid for.
   --   - can only be applied before your FIRST payment — it's a new-signup
   --     perk, not something you can retroactively apply once you're an
   --     active subscriber
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
   --   - referral_reward_granted on the CALLER's row flips to true the
   --     first time this runs for them and is checked up front, so a
   --     second call (e.g. a renewal, or the confirm button being pressed
   --     twice) is a safe no-op.
   --   - pending_referral_code is cleared the moment it's finalized (or
   --     found unusable), so it's never finalized twice.
   --   - the same permanent referral_redemptions uniqueness redeem_referral()
   --     checks before allowing an apply is re-checked here too, so a race
   --     between two tabs both applying-then-paying can't double-insert.
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
     after update on public.businesses
     for each row execute function public.notify_on_subscription_change();

   -- 3) ACCOUNT DELETED — fires from inside delete_own_account() above,
   -- right before that row is actually removed, so you find out when
   -- you're losing a customer.
   drop function if exists public.notify_on_delete() cascade;
   create or replace function public.notify_on_delete()
   returns trigger
   language plpgsql
   security definer
   set search_path = public
   as $$
   begin
     perform public.notify_owner(
       '👋 Account deleted: ' || coalesce(nullif(old.business_name, ''), old.email, 'someone'),
       '<p><b>' || coalesce(nullif(old.business_name, ''), old.email, 'A business') || '</b> just deleted their account.</p>'
     );
     return old;
   end;
   $$;

   drop trigger if exists trg_notify_on_delete on public.businesses;
   create trigger trg_notify_on_delete
     after delete on public.businesses
     for each row execute function public.notify_on_delete();

   ---- END: paste into Supabase SQL Editor ----
============================================================================= */

/* =============================================================================
   OPTIONAL — PAYPAL AUTOMATIC ACTIVATION SETUP (run once, separately from
   the blocks above)
   =============================================================================
   Lets api/paypal-webhook.js (a new serverless function — see the two new
   .js files delivered alongside this one) activate a subscriber's account
   the moment PayPal confirms their payment, the same way the PayMongo
   webhook already does for PH customers. Needed because the webhook runs
   as your app's SERVER, not as the logged-in customer — so it can't call
   markSubscriptionActive()'s underlying RPCs the normal way (those rely on
   auth.uid(), which only exists inside a real customer browser session).
   This function takes the business's id explicitly instead, and is only
   ever callable with your Supabase SERVICE ROLE key (never the public
   anon key), which only your serverless functions ever hold.

   Mirrors markSubscriptionActive() (first payment vs renewal, resetting
   reward credits, one-time referral discount) and finalize_referral_redemption()
   (crediting whoever referred this subscriber) exactly — see those in the
   app code and in the block above for the logic this is copying server-side.
   If you ever change SUBSCRIPTION_PERIOD_DAYS in the app code, update the
   "30" below to match.

   ---- START: paste into Supabase SQL Editor (as a separate query) ----

   drop function if exists public.finalize_referral_redemption_for(uuid) cascade;
   create or replace function public.finalize_referral_redemption_for(p_business_id uuid)
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
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
         set reward_credits = least(coalesce(reward_credits, 0) + 3, 50)
         where id = v_referred_by;
     end if;

     update public.businesses
       set referral_reward_granted = true
       where id = p_business_id;
   end;
   $$;

   -- The one function the webhook actually calls. p_reference should be the
   -- PayPal order/capture id, so it shows up in Settings the same way a
   -- manual payment reference does, and you can look it up in your PayPal
   -- dashboard if a subscriber ever has a billing question.
   drop function if exists public.activate_subscription(uuid, text) cascade;
   create or replace function public.activate_subscription(p_business_id uuid, p_reference text)
   returns void
   language plpgsql
   security definer
   set search_path = public
   as $$
   declare
     v_was_active boolean;
   begin
     select (subscription_status = 'active') into v_was_active
       from public.businesses where id = p_business_id;

     update public.businesses
       set subscription_status = 'active',
           subscription_period_end = now() + interval '30 days',
           payment_reference = p_reference,
           reward_credits = 0,
           discount_percent = case when coalesce(v_was_active, false) then discount_percent else 0 end
       where id = p_business_id;

     if not coalesce(v_was_active, false) then
       perform public.finalize_referral_redemption_for(p_business_id);
     end if;
   end;
   $$;

   -- Deliberately NOT granted to `authenticated` or `anon` — only your
   -- service-role key (which only api/paypal-webhook.js ever holds) can
   -- call this. A logged-in customer's browser key can't call it at all,
   -- which is exactly what stops anyone from activating their own account
   -- for free by guessing this function's name.

   ---- END: paste into Supabase SQL Editor ----
============================================================================= */

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  Coffee, Utensils, Package, BarChart3, ShoppingCart, Plus, PlusCircle, Minus, X,
  Trash2, AlertTriangle, RotateCcw, Pencil, Check, Receipt as ReceiptIcon,
  Tag, Banknote, CreditCard, ImagePlus, Loader2, Camera, History as HistoryIcon,
  Ban, Undo2, ChevronDown, ChevronUp, StickyNote, Coins, ChefHat, Circle, CheckCircle2,
  Settings as SettingsIcon, LogOut, Eye, EyeOff, Store, ArrowRight, Users, ClipboardList,
  Printer, Download, Smartphone, RefreshCw, FileText, UserX,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// Café brand logo (OpSteward QuickServe POS), embedded as a data URI so the
// app stays a single self-contained file with no external asset dependency.
const LOGO_DATA_URL = "data:image/png;base64,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";

// Full Terms & Conditions and Usage Guidelines, embedded as a base64 .docx
// data URI so "Download full terms" works with zero extra hosting/config —
// no separate file to upload to a server, no path to keep in sync. Regenerate
// this constant (base64-encode the .docx) any time the document is revised.
const TERMS_DOCX_DATA_URL =
  "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,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";

const CATALOG_KEY = "cafe_pos_catalog_v1";
const SALES_KEY = "cafe_pos_sales_v1";
// "Parked orders" (a.k.a. tabs): a cart that's been sent to the kitchen and
// is being prepared/served, but hasn't been paid yet — for a customer who
// eats first and pays before leaving, possibly ordering more in between.
// Kept as a separate array from SALES_KEY (finalized, paid transactions) so
// nothing about revenue reports, exports, or the Kitchen board's existing
// logic has to change to account for unpaid orders sitting in the sales
// list. See parkOrder()/settleTab() further down for how a tab is opened
// and eventually turned into a real sale.
const PARKED_ORDERS_KEY = "cafe_pos_parked_orders_v1";
const CURRENCY_KEY = "cafe_pos_currency_v1";
const EMPLOYEES_KEY = "cafe_pos_employees_v1";
const CURRENT_EMPLOYEE_KEY = "cafe_pos_current_employee_v1";
const SHIFTS_KEY = "cafe_pos_shifts_v1";
const WASTE_KEY = "cafe_pos_waste_v1";

// Every one of the local-storage keys above (plus ORDER_COUNTER_KEY further
// down) holds café-operational data — catalog, sales, shifts, waste,
// employees — that used to be shared by WHOEVER was logged in on a given
// device/browser, since the keys themselves were the same no matter which
// account was signed in. That meant two different business accounts using
// the same browser would see each other's sales history.
//
// `scopedKey()` fixes that by suffixing every one of these keys with the
// signed-in owner's Supabase auth user id (a stable UUID — safer to key on
// than email, since email can be changed later without losing your data).
// So "cafe_pos_sales_v1" becomes e.g.
// "cafe_pos_sales_v1::3fa2b1c4-...-91ab" — a completely separate bucket of
// browser storage per account. Returns null (meaning "don't touch storage")
// if there's no signed-in user id yet, so nothing gets read or written
// before we actually know whose data it is.
function scopedKey(baseKey, userId) {
  return userId ? `${baseKey}::${userId}` : null;
}

// ---- Supabase (cloud account, auth, trial, referrals & subscription) ----
// The anon key is safe to ship in client code — it only grants what your
// Row Level Security policies on the `businesses` table allow (see
// supabase-schema.sql). Auth, the trial clock, referral codes/rewards, and
// subscription status all live in Supabase so an owner's account works the
// same on every device, not just the one they signed up on.
// ONE-TIME SETUP for "Forgot password" — Supabase only sends people back to
// URLs you've explicitly allowed. In your Supabase dashboard, go to
// Authentication → URL Configuration, and add the URL where this app is
// hosted (e.g. https://your-app-url.com) under "Redirect URLs". Without
// this, the reset-password email link will fail to bring the owner back
// into the app.
const SUPABASE_URL = "https://tdgcyffbblxxccsujtdy.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GUX0Y4Nyr-zeFAHB2IB0Xw_K7syHDWY";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// PayMongo checkout is now fully automatic for ANY amount — full price,
// the one-time 25% signup referral discount, or any accumulated
// REFERRAL_REWARD_PERCENT (3% per referral) reward credit on a renewal.
// There is no longer a fixed-price PayMongo Payment Link to create or keep
// in sync. Instead, the moment a PH subscriber clicks "Pay now"
// (startPayMongoCheckout() in UpgradeView further below), the app calls a
// tiny serverless function — api/create-paymongo-link.js, sitting in your
// GitHub repo alongside this file — which creates a brand-new PayMongo
// Payment Link at the EXACT peso amount shown on screen and hands back its
// checkout URL. That's what makes PayMongo "automatic": no separate link
// per discount tier, and the amount charged always matches the amount
// shown, no matter how odd the number (an accumulated reward-credit %
// makes for genuinely arbitrary amounts).
//
// WHY THIS NEEDS A SERVERLESS FUNCTION AT ALL: creating a PayMongo Payment
// Link at an arbitrary amount requires PayMongo's SECRET API key (see
// PayMongo's own docs — creating Links/Payment Intents is a server-side-only
// operation). A secret key can NEVER be pasted into this file or any other
// browser-side code — anyone who opened their browser's dev tools would be
// able to read it and then create, capture, or refund charges on your
// PayMongo account. Putting that one secret behind a small serverless
// function (which only Vercel's servers can read, never the browser) is
// the only safe way to get a dynamic amount without running a full backend.
//
// ONE-TIME SETUP (in your Vercel project dashboard — nothing to edit here):
//   1. PayMongo Dashboard → Developers → API Keys → copy your SECRET key
//      (starts with sk_live_… for real charges, sk_test_… while testing).
//   2. Vercel → your project → Settings → Environment Variables → add
//      PAYMONGO_SECRET_KEY = <the secret key from step 1> → Save.
//   3. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the function can
//      see the new variable.
// That's the whole setup — api/create-paymongo-link.js reads
// process.env.PAYMONGO_SECRET_KEY itself; nothing else in this repo needs
// your PayMongo key.
//
// EDIT ME only if you rename/move the serverless function file — this is
// just the URL path the app calls to reach it (relative, so it always
// hits the same domain the POS is hosted on, whatever that domain is).
const PAYMONGO_CREATE_LINK_ENDPOINT = "/api/create-paymongo-link";

// PayMongo only settles Philippine payment methods (GCash, Maya, PH bank
// transfer) and is only shown to subscribers billed in PHP. Everyone else
// (any other currency in CURRENCIES) pays via PayPal instead — see
// isPHCustomer/startPayPalCheckout below in UpgradeView.
//
// PayPal is now fully automatic the SAME way PayMongo is: the moment an
// international subscriber clicks "Pay now", the app calls a tiny
// serverless function — api/create-paypal-order.js — which creates a real
// PayPal Order (via PayPal's Checkout API) for the EXACT amount shown on
// screen, with this account's id attached to it (as the order's custom_id).
// After the subscriber pays, PayPal calls api/paypal-webhook.js directly —
// no browser tab needs to stay open — which reads that same custom_id and
// activates the right account automatically, the same way
// api/paymongo-webhook.js already does for PayMongo. See
// PAYPAL_CREATE_ORDER_ENDPOINT below, and the "PAYPAL AUTOMATIC ACTIVATION
// SETUP" SQL block near the top of this file.
//
// WHY THIS NEEDS A SERVERLESS FUNCTION AT ALL: same reason as PayMongo
// above — creating a PayPal Order and verifying webhook signatures both
// require your PayPal CLIENT SECRET, which can never be pasted into this
// file or any other browser-side code.
//
// ONE-TIME SETUP (in PayPal's Developer Dashboard and your Vercel project
// — nothing to edit here):
//   1. developer.paypal.com/dashboard → Apps & Credentials → Create App
//      → copy the Client ID and Secret it gives you.
//   2. Vercel → your project → Settings → Environment Variables → add:
//        PAYPAL_CLIENT_ID = <from step 1>
//        PAYPAL_CLIENT_SECRET = <from step 1>
//        PAYPAL_ENV = live   (use "sandbox" only while testing)
//        SUPABASE_SERVICE_ROLE_KEY = <Supabase → Settings → API → service_role
//          key — NOT the anon key. Keep this one especially secret; it can
//          bypass every permission check in your database.>
//   3. Back in PayPal's Dashboard, open your app → Webhooks → Add Webhook.
//      Webhook URL: https://<your-app-domain>/api/paypal-webhook
//      Event: check "Checkout order approved" (CHECKOUT.ORDER.APPROVED).
//      Save, then copy the Webhook ID it gives you and add ONE more Vercel
//      env var: PAYPAL_WEBHOOK_ID = <that id>.
//   4. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the functions can
//      see the new variables.
// That's the whole setup — the two new files read these env vars
// themselves; nothing else in this repo needs your PayPal keys.
//
// EDIT ME only if you rename/move the serverless function file.
const PAYPAL_CREATE_ORDER_ENDPOINT = "/api/create-paypal-order";

// Kept only as a fallback link shown in the manual-payment note (see
// MANUAL_PAYMENT_NOTE_INTL) for the rare case where a subscriber's currency
// isn't one PayPal settles in at all (see PAYPAL_SUPPORTED_CURRENCIES
// below), or the automatic Order creation call itself fails. EDIT ME to
// your own PayPal.me username if you want that fallback link to work —
// paypal.com/paypalme.
const PAYPAL_ME_USERNAME = "opsteward";

// PayPal only settles in a specific list of currencies — asking it to
// charge in one it doesn't support (e.g. paypal.me/you/550000IDR) just
// fails on PayPal's own checkout page, no matter how the link was built.
// This is PayPal's publicly documented list of supported currencies as of
// early 2026, filtered down to the ones this app offers in CURRENCIES
// above. PayPal can add or remove currencies over time, so if a subscriber
// ever reports their PayPal checkout rejecting the currency, double-check
// this list against your own PayPal dashboard (Settings → Money) and
// adjust it here.
// Currencies from CURRENCIES that are deliberately left OUT of this set,
// and why: INR (PayPal restricts personal PayPal.me transfers to/within
// India), IDR and VND (PayPal doesn't settle in either at all). Subscribers
// billed in one of those three still fall back to the manual-payment note
// below (see needsManualPayment in UpgradeView) — not because of the
// discount amount, only because of the currency itself.
const PAYPAL_SUPPORTED_CURRENCIES = new Set([
  "PHP", "USD", "EUR", "GBP", "JPY", "AUD", "SGD", "MYR", "THB",
]);

// EDIT ME: your actual monthly subscription price, shown on the Subscribe
// popup. This is what's actually sent (minus any discount) as amountPhp to
// api/create-paymongo-link.js to create the real checkout, so it IS the
// real amount charged for PH subscribers — change it here and every
// PayMongo/PayPal checkout picks it up automatically, no fixed link to
// update.
const MONTHLY_PRICE_PHP = 1699;

// Support contact shown on the sign-up/login screens, the upgrade screen,
// and in Settings, so owners always know where to send billing or account
// questions.
const SUPPORT_EMAIL = "opsteward.support@gmail.com";

// Free trial length, in whole days, starting from trial_start_date.
const TRIAL_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// How long a paid period lasts before renewal is due. Since there's no
// PayMongo webhook wired up (see markSubscriptionActive), this is what
// actually creates a "next bill" for reward credits to apply to — without
// it, "active" would mean active forever with nothing to ever discount.
const SUBSCRIPTION_PERIOD_DAYS = 30;

// Referral program:
//  - REFERRAL_DISCOUNT_PERCENT: a ONE-TIME discount a brand-new subscriber
//    gets on their very first payment (first month only), if they redeemed
//    someone else's code before paying. It's consumed after that first
//    payment (see markSubscriptionActive) — it never applies to renewals.
//  - REFERRAL_REWARD_PERCENT: what the CODE OWNER earns, every time their
//    code is redeemed by someone new. This is a CURRENT-BILLING-MONTH-ONLY
//    credit: it accumulates as new referrals come in during the owner's
//    current billing cycle, then resets back to 0% the moment a new billing
//    cycle starts (see markSubscriptionActive, which zeroes reward_credits
//    on every renewal) — it does NOT roll over or stack across months.
// Both numbers are enforced server-side in the redeem_referral() SQL
// function at the top of this file — these constants are just what the UI
// displays, so keep them in sync if you ever change the SQL.
const REFERRAL_DISCOUNT_PERCENT = 25;
const REFERRAL_REWARD_PERCENT = 3;
// Safety cap on how much of the price reward credits can ever discount.
// Set to 50 so a subscriber's renewal is never more than half off, no
// matter how many referrals they rack up in one billing cycle. This is a
// display/UI cap — the underlying reward_credits column in Supabase keeps
// accumulating past 50 with no ceiling (see redeem_referral() in the SQL
// setup block), but every screen that reads it (UpgradeView, SettingsView)
// clamps to this constant before showing or charging anything, so the
// subscriber is never actually charged below 50% of the full price.
const MAX_REWARD_CREDIT_PERCENT = 50;

// EDIT ME: shown only as a fallback for a PH subscriber, and only if the
// live call to your api/create-paymongo-link.js serverless function fails
// (e.g. PAYMONGO_SECRET_KEY isn't set up yet on Vercel, or PayMongo's API
// is briefly unreachable) — see startPayMongoCheckout() in UpgradeView.
// PayMongo checkout itself is fully automatic for any amount now, so this
// is purely a safety net for that one failure case, not a discount-tier
// limitation.
const MANUAL_PAYMENT_NOTE_PH =
  "We couldn't start PayMongo checkout just now, so pay this exact amount via GCash or bank transfer instead, then enter your reference below.";
// Shown to a non-PH subscriber ONLY when the live call to
// api/create-paypal-order.js itself fails (see needsManualPayment in
// UpgradeView) — currency is no longer the reason this shows at all, since
// startPayPalCheckout now auto-switches unsupported-currency subscribers
// (INR/IDR/VND) to a live USD order automatically. This is purely a
// last-resort fallback for that live call failing.
const MANUAL_PAYMENT_NOTE_INTL =
  "We couldn't start PayPal checkout just now, so pay this exact amount (in USD) via PayPal, then enter your reference below.";
// Order numbers must never repeat, even after old sales are purged from
// RETENTION_MONTHS — so this counter is tracked independently of sales.length
// (which would otherwise shrink and start reissuing old numbers).
const ORDER_COUNTER_KEY = "cafe_pos_order_counter_v1";

// Reports/sales history are kept for this many calendar months (whole months,
// counting the current month as one). Anything older is purged automatically.
const RETENTION_MONTHS = 3;
function purgeOldSales(salesArr) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - (RETENTION_MONTHS - 1), 1);
  const cutoffKey = monthKey(cutoff.getTime());
  return (salesArr || []).filter((s) => monthKey(s.timestamp) >= cutoffKey);
}

// `zeroDecimal: true` currencies (JPY, IDR, VND) are conventionally shown
// with no cents/decimal places — ₦4,061 not ₦4,061.00.
const CURRENCIES = [
  { code: "PHP", symbol: "₱", label: "Philippine Peso (₱)" },
  { code: "USD", symbol: "$", label: "US Dollar ($)" },
  { code: "EUR", symbol: "€", label: "Euro (€)" },
  { code: "GBP", symbol: "£", label: "British Pound (£)" },
  { code: "JPY", symbol: "¥", label: "Japanese Yen (¥)", zeroDecimal: true },
  { code: "AUD", symbol: "A$", label: "Australian Dollar (A$)" },
  { code: "SGD", symbol: "S$", label: "Singapore Dollar (S$)" },
  { code: "MYR", symbol: "RM", label: "Malaysian Ringgit (RM)" },
  { code: "INR", symbol: "₹", label: "Indian Rupee (₹)" },
  { code: "IDR", symbol: "Rp", label: "Indonesian Rupiah (Rp)", zeroDecimal: true },
  { code: "THB", symbol: "฿", label: "Thai Baht (฿)" },
  { code: "VND", symbol: "₫", label: "Vietnamese Dong (₫)", zeroDecimal: true },
];

// Alphabetical (by currency name) view of CURRENCIES, for the sign-up
// currency picker — the base CURRENCIES array above stays in its original
// order since other code doesn't care about order, only this dropdown does.
const CURRENCIES_ALPHABETICAL = [...CURRENCIES].sort((a, b) => a.label.localeCompare(b.label));

// =============================================================================
// LOCKED SUBSCRIPTION PRICING — see MONTHLY_PRICE_PHP / CURRENCIES above.
// =============================================================================
// This is the official monthly list price for each supported currency, set
// by the business (NOT a live/daily exchange-rate conversion). A subscriber
// who picks USD always sees the exact same USD number every day — it never
// silently recalculates from a moving exchange rate. This is a deliberate
// design choice: predictable, round billing numbers beat currency-accurate
// billing for a subscription price.
//
// EDIT ME: to change what a currency is billed, just replace the number
// below — nothing else in the app needs to change, since every screen
// (Settings, Upgrade/Subscribe) reads from this table instead of computing
// its own conversion. Whatever you charge via PayMongo is still in PHP
// (api/create-paymongo-link.js always creates the Payment Link in PHP —
// that's what your Philippine payment processor supports), so these
// other-currency amounts
// are the "what you'll pay in your currency" reference shown to the
// subscriber; the actual PayMongo charge is the PHP amount.
const LOCKED_SUBSCRIPTION_PRICE_PHP = {
  PHP: 1699,
  USD: 35.00,
  EUR: 28.00,
  GBP: 24.00,
  JPY: 5200,
  AUD: 53.00,
  SGD: 47.00,
  MYR: 155.00,
  INR: 2950,
  IDR: 550000,
  THB: 1250,
  VND: 875000,
};

// Formats a subscription-pricing amount (NOT a POS sale amount — see
// `money()` below for that) in a given currency, using that currency's own
// symbol and decimal convention, with thousands separators for the larger
// currencies (JPY/IDR/VND) so e.g. 450800 reads as "Rp450,800" not
// "Rp450800".
function formatSubscriptionAmount(amount, currencyCode) {
  const cur = CURRENCIES.find((c) => c.code === currencyCode) || CURRENCIES[0];
  const n = Number(amount) || 0;
  const decimals = cur.zeroDecimal ? 0 : 2;
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${cur.symbol}${formatted}`;
}

// The locked subscription price for a given currency, falling back to PHP
// if an unrecognized code somehow shows up.
const lockedSubscriptionPrice = (currencyCode) =>
  LOCKED_SUBSCRIPTION_PRICE_PHP[currencyCode] ?? LOCKED_SUBSCRIPTION_PRICE_PHP.PHP;

// Formats an amount the way PayPal.me expects it in the URL — plain digits
// and a ".", no thousands separators, no currency symbol, and the right
// number of decimal places for the currency (0 for JPY-style currencies,
// otherwise 2). This is deliberately different from
// formatSubscriptionAmount()/money() above, which are for on-screen display
// only and include symbols/separators PayPal.me's URL doesn't want.
function formatPayPalAmount(amount, currencyCode) {
  const cur = CURRENCIES.find((c) => c.code === currencyCode) || CURRENCIES[0];
  const n = Math.max(0, Number(amount) || 0);
  return cur.zeroDecimal ? String(Math.round(n)) : n.toFixed(2);
}

// Builds a PayPal.me checkout link priced at the EXACT amount passed in —
// see PAYPAL_ME_USERNAME above for why this replaces maintaining a separate
// fixed-price link per discount tier. Call this with whatever the
// subscriber's real final price works out to (see UpgradeView), and the
// checkout page PayPal shows them will ask for that amount, whether it's
// full price, 25% off a first payment, or some odd number of accumulated
// 3%-per-referral reward credits off a renewal.
function buildPayPalLink(amount, currencyCode) {
  const amt = formatPayPalAmount(amount, currencyCode);
  return `https://www.paypal.com/paypalme/${PAYPAL_ME_USERNAME}/${amt}${currencyCode}`;
}

let CURRENT_SYMBOL = "₱"; // updated each render from the chosen currency, read by money()

const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const money = (n) => `${CURRENT_SYMBOL}${(Number(n) || 0).toFixed(2)}`;
const dateKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const monthKey = (ts) => new Date(ts).toISOString().slice(0, 7);
const todayKey = () => dateKey(Date.now());
const thisMonthKey = () => monthKey(Date.now());
const fmtDay = (k) => new Date(k + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtMonth = (k) => new Date(k + "-01T00:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" });

// An item counts as voided if it says so explicitly. Items on sales made before
// per-item voiding existed won't have this field — for those we fall back to the
// order-level `voided` flag so old fully-voided orders don't silently "unvoid".
const itemIsVoided = (sale, item) => (item.voided !== undefined ? item.voided === true : sale.voided === true);

// Split-payment sales carry a `payments` breakdown (fixed at checkout time);
// plain cash/online sales don't. These two helpers give the cash-only and
// online-only portion of any sale regardless of which shape it is, so
// Reports and shift cash-counting don't need to care which kind they're
// looking at.
const saleCashAmount = (sale) =>
  sale.payments && sale.payments.length
    ? sale.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0)
    : sale.paymentMethod === "cash" ? sale.total : 0;
const saleOnlineAmount = (sale) =>
  sale.payments && sale.payments.length
    ? sale.payments.filter((p) => p.method === "online").reduce((s, p) => s + p.amount, 0)
    : sale.paymentMethod === "online" ? sale.total : 0;

const WASTE_REASONS = ["Spoilage", "Breakage", "Staff meal", "Other"];

function seedCatalog() {
  const ing = (name, unit, stock, low, cost) => ({ id: uid("ing"), name, unit, stock, low, cost });
  const ingredients = [
    ing("Coffee Beans", "g", 3000, 400, 0.9),
    ing("Whole Milk", "ml", 6000, 1000, 0.06),
    ing("Oat Milk", "ml", 3000, 800, 0.12),
    ing("Vanilla Syrup", "ml", 1000, 200, 0.35),
    ing("Caramel Syrup", "ml", 1000, 200, 0.35),
    ing("Sugar", "g", 2000, 300, 0.03),
    ing("Croissant (baked)", "pcs", 12, 4, 28),
    ing("Sliced Bread", "pcs", 20, 6, 6),
    ing("Ham", "g", 1000, 200, 0.6),
    ing("Cheese Slice", "pcs", 24, 8, 8),
    ing("Egg", "pcs", 60, 12, 8),
    ing("Steamed Rice", "serving", 40, 10, 12),
  ];
  const byName = Object.fromEntries(ingredients.map((i) => [i.name, i.id]));
  const prod = (name, category, price, recipe) => ({ id: uid("prod"), name, category, price, recipe });
  const products = [
    prod("Espresso", "drink", 95, [{ ingredientId: byName["Coffee Beans"], amount: 18 }]),
    prod("Americano", "drink", 105, [{ ingredientId: byName["Coffee Beans"], amount: 18 }]),
    prod("Cafe Latte", "drink", 130, [
      { ingredientId: byName["Coffee Beans"], amount: 18 },
      { ingredientId: byName["Whole Milk"], amount: 200 },
    ]),
    prod("Oat Latte", "drink", 145, [
      { ingredientId: byName["Coffee Beans"], amount: 18 },
      { ingredientId: byName["Oat Milk"], amount: 200 },
    ]),
    prod("Caramel Macchiato", "drink", 155, [
      { ingredientId: byName["Coffee Beans"], amount: 18 },
      { ingredientId: byName["Whole Milk"], amount: 180 },
      { ingredientId: byName["Caramel Syrup"], amount: 30 },
    ]),
    prod("Vanilla Latte", "drink", 150, [
      { ingredientId: byName["Coffee Beans"], amount: 18 },
      { ingredientId: byName["Whole Milk"], amount: 180 },
      { ingredientId: byName["Vanilla Syrup"], amount: 30 },
    ]),
    prod("Croissant", "food", 110, [{ ingredientId: byName["Croissant (baked)"], amount: 1 }]),
    prod("Ham & Cheese Sandwich", "food", 145, [
      { ingredientId: byName["Sliced Bread"], amount: 2 },
      { ingredientId: byName["Ham"], amount: 60 },
      { ingredientId: byName["Cheese Slice"], amount: 1 },
    ]),
    prod("Ham, Egg & Rice Meal", "food", 165, [
      { ingredientId: byName["Steamed Rice"], amount: 1 },
      { ingredientId: byName["Egg"], amount: 2 },
      { ingredientId: byName["Ham"], amount: 60 },
    ]),
  ];
  const categories = [
    { id: "drink", name: "Drinks" },
    { id: "food", name: "Food" },
  ];
  return { ingredients, products, categories };
}

const categoryIcon = (catId) => (catId === "drink" ? Coffee : catId === "food" ? Utensils : Tag);

const UNITS = [
  { id: "g", label: "grams (g)" },
  { id: "ml", label: "millilitres (ml)" },
  { id: "pcs", label: "pieces (pcs)" },
  { id: "serving", label: "servings" },
];
const unitLabel = (u) => (UNITS.find((x) => x.id === u) || { id: u }).id || u;

// Café-local data (catalog, sales, shifts, waste log, employee PINs) stays
// on this device in localStorage — it's operational point-of-sale data, not
// account data, so there's no need to round-trip it through the network on
// every keystroke. Only the owner's account, trial, referral and
// subscription info live in Supabase (see below), so that part works
// correctly across every device the owner logs into. Every key passed in
// here is expected to already be scoped per-account via scopedKey() — a
// null key (no signed-in user yet) is a deliberate no-op, not an error.
async function safeGet(key) {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
async function safeSet(key, value) {
  if (!key) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Downscale + compress an uploaded image so it stays small in shared storage.
function fileToResizedDataURL(file, maxWidth = 480, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) { reject(new Error("not an image")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("bad image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export default function CafePOS() {
  const updateWaitingToApply = useAppUpdate();
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState({ ingredients: [], products: [], categories: [] });
  const [sales, setSales] = useState([]);
  // Open tabs — carts sent to the kitchen but not paid yet. See
  // PARKED_ORDERS_KEY above and parkOrder()/settleTab() further down.
  const [parkedOrders, setParkedOrders] = useState([]);
  const [parkModalOpen, setParkModalOpen] = useState(false); // naming a new tab from the current cart
  const [settleTabTarget, setSettleTabTarget] = useState(null); // tab object being paid off in SettleTabModal
  const [nextOrderNo, setNextOrderNo] = useState(1);
  const [currencyCode, setCurrencyCode] = useState("PHP");
  const [view, setView] = useState("pos");
  const [cart, setCart] = useState([]); // {productId, qty}
  const [posFilter, setPosFilter] = useState("all");
  const [toast, setToast] = useState(null);
  const [ingModal, setIngModal] = useState(null); // null | {} | ingredient
  const [prodModal, setProdModal] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [reportMode, setReportMode] = useState("day");
  const [reportDay, setReportDay] = useState(todayKey());
  const [reportMonth, setReportMonth] = useState(thisMonthKey());
  const [reportRangeStart, setReportRangeStart] = useState(todayKey());
  const [reportRangeEnd, setReportRangeEnd] = useState(todayKey());
  const [historyMode, setHistoryMode] = useState("day");
  const [historyDay, setHistoryDay] = useState(todayKey());
  const [historyRangeStart, setHistoryRangeStart] = useState(todayKey());
  const [historyRangeEnd, setHistoryRangeEnd] = useState(todayKey());
  const [voidModal, setVoidModal] = useState(null); // sale being voided
  const [restoreModal, setRestoreModal] = useState(null); // sale being restored (needs manager approval)
  const [detailSale, setDetailSale] = useState(null); // sale being viewed in detail
  const [restockId, setRestockId] = useState(null);
  const [restockVal, setRestockVal] = useState("");
  const [catModal, setCatModal] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [cashReceived, setCashReceived] = useState("");
  const [discountType, setDiscountType] = useState("none"); // 'none' | 'percent' | 'amount'
  const [discountValue, setDiscountValue] = useState("");
  const [paymentProof, setPaymentProof] = useState(null); // resized dataURL, optional
  const [proofProcessing, setProofProcessing] = useState(false);
  const [employees, setEmployees] = useState([]); // [{id, name, role, pin}]
  const [currentEmployeeId, setCurrentEmployeeId] = useState(null);
  const [employeeModal, setEmployeeModal] = useState(false);
  // Split payment: a list of legs, each independently cash or online. Every
  // leg except the last is a manually typed amount; the last one automatically
  // takes whatever's left of the total, so legs always add up exactly and the
  // cashier only has to type n-1 numbers. Defaults to the common case (cash
  // leg + online leg) but either leg's method can be changed, and more legs
  // can be added for a 3+ way split (e.g. cash + cash + online).
  const [splitPayments, setSplitPayments] = useState([
    { method: "cash", amount: "" },
    { method: "online", amount: "" },
  ]);
  // Split payments can be divided by typed amount ("amount") or by assigning
  // whole cart lines to a leg ("items") — e.g. "she's paying for the coffees,
  // he's paying for the sandwiches." splitItemLegs maps productId -> leg index.
  const [splitMode, setSplitMode] = useState("amount"); // 'amount' | 'items'
  const [splitItemLegs, setSplitItemLegs] = useState({});
  const [shifts, setShifts] = useState([]); // [{id, openedAt, openedById, openedByName, openingFloat, closedAt, closedById, closedByName, countedCash, expectedCash, variance, note}]
  const [wasteLogs, setWasteLogs] = useState([]); // [{id, timestamp, ingredientId, ingredientName, unit, amount, reason, note, cost, loggedById, loggedByName, batchId?, productId?, productName?, productQty?}]
  const [wasteModal, setWasteModal] = useState(false);
  const [shiftCloseModal, setShiftCloseModal] = useState(false);
  // Set to the id of the employee being switched TO while a shift is open —
  // opens the handoff modal (count out the outgoing person, float in the
  // incoming one) instead of silently swapping who's on the register.
  const [pendingEmployeeSwitch, setPendingEmployeeSwitch] = useState(null);

  // ---- Owner account / login (Sign-Up + Settings), backed by Supabase ----
  // `account` is the UI-shaped view of the business's row in the `businesses`
  // table, joined with what we need from the Supabase Auth user.
  const [account, setAccount] = useState(null); // null = signed out; business profile once signed in
  const [authUser, setAuthUser] = useState(null); // raw Supabase auth user
  const [loggedIn, setLoggedIn] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'signup', toggled on the auth screen
  // True while the owner is in the middle of a "forgot password" flow —
  // Supabase fires a PASSWORD_RECOVERY auth event when they land back on the
  // app from the reset-password email link. While this is true we show a
  // dedicated "choose a new password" screen instead of either the login
  // form or the main app, even though a session technically exists.
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const accountRef = useRef(null);
  // Always holds the currently-signed-in Supabase auth user id (or null
  // when signed out), kept in a ref so every safeGet/safeSet call site can
  // read the CURRENT value at call-time via scopedKey() without having to
  // thread authUser through a long chain of useCallback dependency arrays.
  const authUserIdRef = useRef(null);
  // Owner opened the Upgrade screen voluntarily (e.g. from the trial banner
  // or Settings) while still inside their trial window. Once the trial
  // actually expires, the upgrade screen is shown automatically instead —
  // see the `trialInfo.expired` gate below.
  const [showUpgrade, setShowUpgrade] = useState(false);

  // Reads the signed-in owner's row from `businesses` and reshapes it for
  // the UI. Returns null if the row doesn't exist yet (e.g. the insert after
  // sign-up hasn't landed) or the request fails.
  const fetchBusiness = useCallback(async (userId) => {
    const { data, error } = await supabase
      .from("businesses")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      id: data.id,
      businessName: data.business_name,
      email: data.email,
      referralCode: data.referral_code,
      referredBy: data.referred_by,
      discountPercent: Number(data.discount_percent) || 0,
      rewardCredits: Number(data.reward_credits) || 0,
      referralCount: data.referral_count || 0,
      trialStartDate: data.trial_start_date,
      subscriptionStatus: data.subscription_status || "trial",
      subscriptionPeriodEnd: data.subscription_period_end || null,
      paymentReference: data.payment_reference || "",
      // Set once at sign-up (see SignUpView) and never changed afterward —
      // this is the account's single, permanent billing/display currency.
      // Falls back to PHP only for pre-existing accounts created before
      // this field existed.
      currencyCode: data.currency_code || "PHP",
    };
  }, []);

  // ---- Cross-device sync of café data (catalog, sales, employees, shifts,
  // waste log, parked tabs, order counter) ----
  // Everything above (fetchBusiness) is the owner's ACCOUNT — trial,
  // subscription, referral — which already lived in Supabase and therefore
  // already followed the owner to any device. Day-to-day café data used to
  // live ONLY in this one browser's localStorage (see safeGet/safeSet
  // above), which is why logging into the same account on a second device
  // showed nothing. These two functions read/write a single JSON blob
  // (`pos_data`) on that same `businesses` row, so the café's real data
  // travels with the account the same way the subscription already does.
  // Requires a one-time Supabase migration — see the SQL block near the top
  // of this file (search "pos_data").
  const fetchPosData = useCallback(async (userId) => {
    if (!userId) return null;
    try {
      const { data, error } = await supabase
        .from("businesses")
        .select("pos_data, pos_data_updated_at")
        .eq("id", userId)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    } catch (err) {
      console.error("fetchPosData failed:", err);
      return null;
    }
  }, []);

  // Fire-and-forget upload of the full current snapshot. Local storage (see
  // safeSet calls throughout this file) stays the fast, offline-safe copy
  // that every screen actually reads and writes to instantly — this just
  // mirrors that same snapshot up to Supabase in the background so a DIFFERENT
  // device can pick it up next time it logs in. If it fails (e.g. no
  // connection), the local copy is completely unaffected; it'll just try
  // again on the next change.
  const pushPosData = useCallback(async (userId, blob) => {
    if (!userId) return false;
    try {
      const { error } = await supabase
        .from("businesses")
        .update({ pos_data: blob, pos_data_updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
      return true;
    } catch (err) {
      console.error("pushPosData failed:", err);
      return false;
    }
  }, []);
  // updates account state — this is what lets the app notice a payment
  // went through (api/paymongo-webhook.js flipping subscription_status in
  // the database) WITHOUT the owner having to manually refresh the page.
  // See pollForActivation() in UpgradeView, which calls this repeatedly
  // while a payment popup is open.
  const refreshAccountStatus = useCallback(async () => {
    if (!authUserIdRef.current) return null;
    const biz = await fetchBusiness(authUserIdRef.current);
    if (biz) {
      accountRef.current = biz;
      setAccount(biz);
    }
    return biz;
  }, [fetchBusiness]);

  useEffect(() => {
    let mounted = true;

    const applySession = async (session) => {
      if (session?.user) {
        const biz = await fetchBusiness(session.user.id);
        if (!mounted) return;
        authUserIdRef.current = session.user.id;
        setAuthUser(session.user);
        accountRef.current = biz;
        setAccount(biz);
        setLoggedIn(true);
      } else {
        if (!mounted) return;
        authUserIdRef.current = null;
        setAuthUser(null);
        accountRef.current = null;
        setAccount(null);
        setLoggedIn(false);
      }
      if (mounted) setAuthChecked(true);
    };

    supabase.auth.getSession().then(({ data }) => applySession(data?.session || null));

    // Keeps every open tab/device in sync — e.g. logging out on one device,
    // or a password/email change, is reflected everywhere immediately.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        // Clicking the "reset your password" email link lands here with a
        // real session already established — don't drop the owner straight
        // into the app, send them to the "choose a new password" screen.
        if (mounted) setPasswordRecovery(true);
      }
      applySession(session);
    });

    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, [fetchBusiness]);

  // Trial / subscription status, recomputed whenever the account changes.
  // subscriptionStatus becomes "active" once an upgrade payment is
  // confirmed (see markSubscriptionActive) and stays "active" from then on
  // — but that alone would mean "active forever" with no next bill for
  // reward credits to ever apply to. subscriptionPeriodEnd is what actually
  // creates a recurring "renewal due" moment: once it passes, `expired`
  // flips back on (reusing the same hard-block gate the trial uses) and
  // `isSubscribed` flips off, until they renew and pay again.
  //
  // `isSubscribed` (is_subscribed) — true ONLY while the account is an
  //   active, PAYING subscriber with an unexpired paid period. This is the
  //   single source of truth the rest of the app uses to gate anything
  //   that's "subscriber-only" — including whether a referral code is shown
  //   at all, and whether using someone's code earns THEM a reward credit
  //   (see redeem_referral() in the SQL setup block, which enforces the
  //   same rule server-side).
  // `isFreeTrial` (is_free_trial) — true whenever the account hasn't ever
  //   completed a paid upgrade yet, whether or not the countdown itself has
  //   run out. A trial that's expired is still "under Free Trial" in the
  //   sense that matters here: no code, no credits, until they pay.
  const trialInfo = useMemo(() => {
    if (!account) {
      return { daysLeft: TRIAL_DAYS, elapsedDays: 0, expired: false, isSubscribed: false, isFreeTrial: true, renewalDue: false };
    }
    if (account.subscriptionStatus === "active") {
      const periodEndMs = account.subscriptionPeriodEnd ? new Date(account.subscriptionPeriodEnd).getTime() : null;
      // A missing or unparseable period end (e.g. an account flipped to
      // "active" by hand in the Supabase table editor without also setting
      // subscription_period_end — see the SQL setup notes at the top of
      // this file) must NOT be read as "never renews": that would leave
      // the POS usable forever with no monthly bill ever shown. Treat an
      // unknown period end as due-now instead, so the same hard-block
      // renewal popup always appears rather than silently granting free
      // access.
      const renewalDue = !Number.isFinite(periodEndMs) || Date.now() >= periodEndMs;
      const isSubscribed = !renewalDue;
      return {
        daysLeft: null,
        elapsedDays: null,
        expired: renewalDue,
        isSubscribed,
        // Once you've ever paid, you're never treated as "on the free
        // trial" again — even if a renewal is currently due, you're a
        // lapsed subscriber, not a trial user, for referral-eligibility
        // purposes (a lapsed subscriber's code stays hidden too, but for a
        // different displayed reason — see SettingsView/UpgradeView).
        isFreeTrial: false,
        renewalDue,
        periodEndMs,
      };
    }
    const start = new Date(account.trialStartDate).getTime();
    const elapsedDays = Number.isFinite(start) ? Math.floor((Date.now() - start) / MS_PER_DAY) : 0;
    const daysLeft = Math.max(0, TRIAL_DAYS - elapsedDays);
    return {
      daysLeft,
      elapsedDays,
      expired: elapsedDays >= TRIAL_DAYS,
      isSubscribed: false,
      isFreeTrial: true,
      renewalDue: false,
    };
  }, [account]);

  // Loads (or seeds) this ACCOUNT's local café data — catalog, sales,
  // employees, shifts, waste log, currency, order counter. Re-runs any time
  // the signed-in user id changes: on login, on logout, and on switching to
  // a different account in the same browser — each with its own completely
  // separate bucket of localStorage, via scopedKey() (see its comment near
  // CATALOG_KEY above). Nothing is read or written to storage until we
  // actually know which account we're loading for.
  useEffect(() => {
    const userId = authUser?.id || null;

    if (!userId) {
      // Signed out (or not yet signed in): don't touch storage, and don't
      // leave a previous account's data sitting in memory — reset to
      // clean, empty defaults. The login/signup screen is what actually
      // renders at this point (see the `!loggedIn` gate further down), so
      // this is just hygiene, not something the person will see.
      setCatalog({ ingredients: [], products: [], categories: [] });
      setSales([]);
      setParkedOrders([]);
      setNextOrderNo(1);
      setCurrencyCode("PHP");
      setEmployees([]);
      setCurrentEmployeeId(null);
      setShifts([]);
      setWasteLogs([]);
      setLoading(true);
      return;
    }

    (async () => {
      setLoading(true);
      let cat = await safeGet(scopedKey(CATALOG_KEY, userId));
      let sal = await safeGet(scopedKey(SALES_KEY, userId));
      let parked = await safeGet(scopedKey(PARKED_ORDERS_KEY, userId));
      let cur = await safeGet(scopedKey(CURRENCY_KEY, userId));
      let emps = await safeGet(scopedKey(EMPLOYEES_KEY, userId));
      let curEmpId = await safeGet(scopedKey(CURRENT_EMPLOYEE_KEY, userId));
      let shiftsData = await safeGet(scopedKey(SHIFTS_KEY, userId));
      let wasteData = await safeGet(scopedKey(WASTE_KEY, userId));
      let orderCounter = await safeGet(scopedKey(ORDER_COUNTER_KEY, userId));
      if (!cat) { cat = seedCatalog(); await safeSet(scopedKey(CATALOG_KEY, userId), cat); }
      if (!cat.categories) {
        const found = Array.from(new Set(cat.products.map((p) => p.category)));
        cat.categories = found.length
          ? found.map((c) => ({ id: c, name: c.charAt(0).toUpperCase() + c.slice(1) }))
          : [{ id: "drink", name: "Drinks" }, { id: "food", name: "Food" }];
        await safeSet(scopedKey(CATALOG_KEY, userId), cat);
      }
      if (!sal) { sal = []; await safeSet(scopedKey(SALES_KEY, userId), sal); }
      if (!parked) { parked = []; await safeSet(scopedKey(PARKED_ORDERS_KEY, userId), parked); }
      // Reports/history only need to keep RETENTION_MONTHS worth of whole months.
      const purged = purgeOldSales(sal);
      if (purged.length !== sal.length) { sal = purged; await safeSet(scopedKey(SALES_KEY, userId), sal); }
      if (!cur) {
        // First time loading on this device: seed from the account's
        // permanent, server-side currency (set once at sign-up) rather than
        // always defaulting to PHP — so a returning owner on a new device
        // sees their own currency, not a reset one.
        cur = accountRef.current?.currencyCode || "PHP";
        await safeSet(scopedKey(CURRENCY_KEY, userId), cur);
      }
      if (!emps || emps.length === 0) {
        emps = [
          { id: uid("emp"), name: "Jamie", role: "manager" },
          { id: uid("emp"), name: "Sam", role: "staff" },
        ];
        await safeSet(scopedKey(EMPLOYEES_KEY, userId), emps);
      }
      // Older saved employee lists won't have a `role` yet — default them to
      // "staff" so the Manager/Staff grouping always has something to show.
      if (emps.some((e) => !e.role)) {
        emps = emps.map((e) => (e.role ? e : { ...e, role: "staff" }));
        await safeSet(scopedKey(EMPLOYEES_KEY, userId), emps);
      }
      // A previous version of the seed used the category itself as the
      // placeholder name ("Manager" / "Staff"), which made the category look
      // like a selectable employee. Rename those two exact placeholders back
      // to example names — real employees with other names are left alone.
      if (
        emps.length === 2 &&
        emps.some((e) => e.name === "Manager" && e.role === "manager") &&
        emps.some((e) => e.name === "Staff" && e.role === "staff")
      ) {
        emps = emps.map((e) =>
          e.name === "Manager" && e.role === "manager" ? { ...e, name: "Jamie" } :
          e.name === "Staff" && e.role === "staff" ? { ...e, name: "Sam" } : e
        );
        await safeSet(scopedKey(EMPLOYEES_KEY, userId), emps);
      }
      if (!curEmpId || !emps.some((e) => e.id === curEmpId)) {
        curEmpId = emps[0].id;
        await safeSet(scopedKey(CURRENT_EMPLOYEE_KEY, userId), curEmpId);
      }
      if (!shiftsData) { shiftsData = []; await safeSet(scopedKey(SHIFTS_KEY, userId), shiftsData); }
      if (!wasteData) { wasteData = []; await safeSet(scopedKey(WASTE_KEY, userId), wasteData); }
      if (!orderCounter) {
        // First run on this counter — pick up numbering after the highest
        // order number already on file so upgrades don't restart at 1.
        const maxExisting = Math.max(
          0,
          ...sal.map((s) => s.orderNo || 0),
          ...parked.map((t) => t.orderNo || 0)
        );
        orderCounter = maxExisting + 1;
        await safeSet(scopedKey(ORDER_COUNTER_KEY, userId), orderCounter);
      }
      setCatalog(cat);
      setSales(sal);
      setParkedOrders(parked);
      setNextOrderNo(orderCounter);
      setCurrencyCode(cur);
      setEmployees(emps);
      setCurrentEmployeeId(curEmpId);
      setShifts(shiftsData);
      setWasteLogs(wasteData);
      setLoading(false);
    })();
  }, [authUser?.id]);

  const changeCurrency = useCallback(async (code) => {
    setCurrencyCode(code);
    const ok = await safeSet(scopedKey(CURRENCY_KEY, authUserIdRef.current), code);
    if (!ok) notify("Couldn't save the currency — check connection and try again.", "err");
  }, []);

  CURRENT_SYMBOL = (CURRENCIES.find((c) => c.code === currencyCode) || CURRENCIES[0]).symbol;

  const notify = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Once a new version has taken over in the background (see useAppUpdate
  // above), don't reload immediately — wait until the register is actually
  // quiet: an empty cart and nothing open (no modal, no in-progress void/
  // restore/checkout, etc.). Checked every couple of seconds; the moment
  // it's quiet, we reload once to pick up the new version. A manual
  // "Refresh now" button in the banner lets someone override this and
  // apply it immediately if they'd rather not wait.
  const isQuietMoment = () =>
    cart.length === 0 &&
    !ingModal && !prodModal && !receipt && !voidModal && !restoreModal &&
    !catModal && !parkModalOpen && !settleTabTarget && !employeeModal &&
    !detailSale && !restockId && !checkoutError;

  useEffect(() => {
    if (!updateWaitingToApply) return;
    if (isQuietMoment()) {
      window.location.reload();
      return;
    }
    const interval = setInterval(() => {
      if (isQuietMoment()) window.location.reload();
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    updateWaitingToApply, cart, ingModal, prodModal, receipt, voidModal,
    restoreModal, catModal, parkModalOpen, settleTabTarget, employeeModal,
    detailSale, restockId, checkoutError,
  ]);

  // Creates a new owner account via Supabase Auth, then a matching row in
  // `businesses` (business name, email, and trial_start_date = now). If the
  // signer-upper typed someone else's referral code, it's redeemed
  // atomically server-side via the redeem_referral() function — that's what
  // grants the 25% discount to this new account and the 3% reward credit to
  // the referrer, and it's the source of truth so a client can't just fake
  // a discount for itself.
  // Returns `true` on success, or a plain-English error STRING on failure —
  // never a bare `false` — so the sign-up screen can actually tell the owner
  // what went wrong (e.g. "you already have an account, log in instead")
  // instead of a generic "something went wrong, try again."
  const signUp = useCallback(async ({ businessName, email, password, currencyCode, referralCode }) => {
    const cleanEmail = email.trim();
    const cleanBusinessName = businessName.trim();

    // Currency is chosen once, right here, and never changes afterward — it
    // drives both POS totals and the subscription price shown in Settings.
    // Computed BEFORE signUp() now, so it can be passed as metadata below —
    // the server-side trigger (see handle_new_user() in supabase-schema.sql)
    // needs it available the instant the auth user is created, not after.
    const chosenCurrency = CURRENCIES.some((c) => c.code === currencyCode) ? currencyCode : "PHP";

    // business_name/currency_code are passed via `options.data` so they land
    // in auth.users.raw_user_meta_data. A database trigger reads them from
    // there to create the businesses row SERVER-SIDE, the instant the auth
    // account is created — regardless of whether a session exists yet. This
    // matters because if "Confirm email" is turned on in your Supabase
    // project, signUp() returns a user but no session until they click the
    // confirmation link, and the client-side insert below would otherwise be
    // silently blocked by Row Level Security (no session = no auth.uid()),
    // leaving the account with no business/trial row at all.
    const { data, error } = await supabase.auth.signUp({
      email: cleanEmail,
      password,
      options: { data: { business_name: cleanBusinessName, currency_code: chosenCurrency } },
    });
    if (error) {
      if (error.code === "user_already_exists" || /already registered/i.test(error.message || "")) {
        return "An account with this email already exists. Log in instead.";
      }
      return error.message || "Couldn't create the account.";
    }
    const user = data?.user;
    if (!user) {
      return "Couldn't create the account — please try again.";
    }

    // Fallback / fast-path only — the trigger above is what actually
    // guarantees the row exists. This upsert just means that when a session
    // DOES exist immediately (the common case, "Confirm email" off), the row
    // is ready the instant we call fetchBusiness() below, without waiting on
    // trigger timing. onConflict: "id" makes this safe to run whether or not
    // the trigger already created the row — it merges instead of erroring.
    const { error: bizErr } = await supabase.from("businesses").upsert(
      {
        id: user.id,
        business_name: cleanBusinessName,
        email: cleanEmail,
        trial_start_date: new Date().toISOString(),
        currency_code: chosenCurrency,
      },
      { onConflict: "id" }
    );
    if (bizErr) {
      // No longer fatal to the account existing — the trigger already
      // guarantees a row is there — but still worth surfacing.
      notify("Account created, but saving your business details failed: " + bizErr.message, "err");
    }
    // Seed this device's local copy immediately too, so the very first
    // render (before fetchBusiness round-trips) already shows the right
    // currency instead of a brief flash of PHP.
    await safeSet(scopedKey(CURRENCY_KEY, user.id), chosenCurrency);

    if (referralCode && referralCode.trim()) {
      const { error: refErr } = await supabase.rpc("redeem_referral", {
        p_code: referralCode.trim().toUpperCase(),
      });
      if (refErr) {
        notify("Account created — but that referral code couldn't be applied: " + refErr.message, "err");
      }
    }

    // If your Supabase project has email confirmation turned on, there's no
    // session yet — the owner needs to confirm their email, then log in.
    if (!data.session) {
      notify("Account created — check your email to confirm it, then log in.");
      setAuthMode("login");
      return true;
    }

    const biz = await fetchBusiness(user.id);
    accountRef.current = biz;
    setAccount(biz);
    setAuthUser(user);
    setLoggedIn(true);
    notify(`Welcome, ${biz?.businessName || businessName}! Your ${TRIAL_DAYS}-day free trial has started.`);
    return true;
  }, [notify, fetchBusiness]);

  // Same idea as signUp: returns `true`, or a plain-English error STRING —
  // e.g. "Email or password is incorrect" vs. "No account with that email
  // yet — sign up instead" are different situations and deserve different
  // messages instead of one generic failure.
  const logIn = useCallback(async ({ email, password }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      if (/invalid login credentials/i.test(error.message || "")) {
        return "Email or password is incorrect.";
      }
      return error.message || "Couldn't log in — please try again.";
    }
    if (!data?.user) return "Couldn't log in — please try again.";
    const biz = await fetchBusiness(data.user.id);
    accountRef.current = biz;
    setAccount(biz);
    setAuthUser(data.user);
    setLoggedIn(true);
    return true;
  }, [fetchBusiness]);

  const logOut = useCallback(async () => {
    await supabase.auth.signOut();
    accountRef.current = null;
    setAccount(null);
    setAuthUser(null);
    setLoggedIn(false);
  }, []);

  // "Forgot password" — sends the owner an email with a link back into this
  // app; clicking it triggers the PASSWORD_RECOVERY event handled above.
  // Returns `true` on success, or a plain-English error STRING on failure.
  // Deliberately doesn't reveal whether the email is actually registered
  // (Supabase's own response doesn't distinguish this either) — the login
  // screen shows the same "check your email" message either way.
  const requestPasswordReset = useCallback(async (email) => {
    const cleanEmail = (email || "").trim();
    if (!cleanEmail) return "Enter your email first.";
    const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
      redirectTo: window.location.href,
    });
    if (error) return error.message || "Couldn't send the reset email — please try again.";
    return true;
  }, []);

  // Called from the "choose a new password" screen once a recovery session
  // is active. Sets the new password, then drops the owner into the app
  // (the session from the recovery link is a real, valid session).
  const completePasswordRecovery = useCallback(async (newPassword) => {
    if (!newPassword || newPassword.length < 6) return "Password must be at least 6 characters.";
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return error.message || "Couldn't update your password — please try again.";
    setPasswordRecovery(false);
    notify("Password updated — you're logged in.");
    return true;
  }, [notify]);

  // Bail out of the recovery flow without changing the password — signs out
  // so the owner lands back on a normal login screen instead of being left
  // half-authenticated in limbo.
  const cancelPasswordRecovery = useCallback(async () => {
    setPasswordRecovery(false);
    await supabase.auth.signOut();
  }, []);

  // Permanently deletes the signed-in owner's account: their `businesses`
  // row and their Supabase Auth user. The anon key can't delete an auth
  // user directly, so this calls a Postgres function (delete_own_account,
  // see supabase-schema.sql) that runs with elevated privileges and only
  // ever acts on auth.uid() — the caller's own account, never anyone
  // else's. On success we sign out locally and drop back to the
  // sign-up/login screen; the business's sales/catalog data stays on this
  // device's local storage (it isn't wiped), only the cloud account goes.
  const deleteAccount = useCallback(async () => {
    if (!authUser) return false;
    try {
      const { error } = await supabase.rpc("delete_own_account");
      if (error) throw error;
      await supabase.auth.signOut();
      accountRef.current = null;
      setAccount(null);
      setAuthUser(null);
      setLoggedIn(false);
      notify("Your account has been deleted.");
      return true;
    } catch (e) {
      notify("Couldn't delete your account — " + (e?.message || "check your connection and try again."), "err");
      return false;
    }
  }, [authUser, notify]);

  // Cancels the signed-in owner's PAID subscription WITHOUT deleting their
  // account — unlike deleteAccount() above, the login, the businesses row,
  // and every permanent record on it (referral_code, referred_by,
  // referral_count, and — critically — the referral_redemptions table keyed
  // by their email, see the SQL setup block at the top of this file) all
  // stay exactly as they are. Only subscription_status/subscription_period_end/
  // payment_reference are cleared, which immediately locks the POS behind
  // the paywall again (trialInfo falls back to the original, long-expired
  // trial window — see the trialInfo useMemo above — since account.trialStartDate
  // is untouched).
  //
  // Deliberately NOT touched here: referred_by, discount_percent,
  // reward_credits, referral_count. Leaving referred_by set is what makes
  // redeem_referral() on the server keep refusing "You've already redeemed
  // a referral code" if this owner ever tries to apply ANY code again after
  // resubscribing — and referral_redemptions (permanent, keyed by email —
  // survives even a full account deletion) independently blocks reusing the
  // exact same code even in the hypothetical case referred_by was ever
  // cleared. So "no re-using a promo code across an unsubscribe" falls out
  // of infrastructure that already exists; this function doesn't need to
  // duplicate it.
  //
  // Because subscription_status is no longer "active", two things fall out
  // for free the next time this owner subscribes again:
  //   1. hasSubscribedBefore (see UpgradeView) recomputes to false, so the
  //      Upgrade screen shows "Upgrade your account" / a first-time
  //      subscribe price breakdown instead of "Manage your subscription".
  //   2. markSubscriptionActive()'s isFirstPayment recomputes to true, so
  //      the confirmation toast is the "You're upgraded — thanks for
  //      subscribing!" NEW SUBSCRIBER message, not the "Renewed —..." one.
  const unsubscribeAccount = useCallback(async () => {
    if (!authUser) return false;
    try {
      const updates = {
        subscription_status: "cancelled",
        subscription_period_end: null,
        payment_reference: null,
      };
      const { error } = await supabase.from("businesses").update(updates).eq("id", authUser.id);
      if (error) throw error;
      const next = {
        ...(accountRef.current || {}),
        subscriptionStatus: "cancelled",
        subscriptionPeriodEnd: null,
        paymentReference: "",
      };
      accountRef.current = next;
      setAccount(next);
      notify("You've unsubscribed. You can resubscribe any time from Settings.");
      return true;
    } catch (e) {
      notify("Couldn't unsubscribe — " + (e?.message || "check your connection and try again."), "err");
      return false;
    }
  }, [authUser, notify]);

  // Used by the Settings page — saves a single field (businessName, email,
  // or password) the moment the owner is done typing it. Email and password
  // changes go through Supabase Auth itself (so login credentials actually
  // change); business name is just a column on `businesses`. Reads/writes
  // accountRef (kept in sync below) instead of the `account` state directly,
  // so two fields autosaving close together can't clobber each other.
  const updateAccountField = useCallback(async (field, value) => {
    if (!authUser) return false;
    try {
      if (field === "password") {
        const { error } = await supabase.auth.updateUser({ password: value });
        if (error) throw error;
        notify("Password updated.");
        return true;
      }
      if (field === "email") {
        const { error } = await supabase.auth.updateUser({ email: value });
        if (error) throw error;
        await supabase.from("businesses").update({ email: value }).eq("id", authUser.id);
        const next = { ...(accountRef.current || {}), email: value };
        accountRef.current = next;
        setAccount(next);
        notify("Check your new email address to confirm the change.");
        return true;
      }
      // businessName
      const { error } = await supabase.from("businesses").update({ business_name: value }).eq("id", authUser.id);
      if (error) throw error;
      const next = { ...(accountRef.current || {}), businessName: value };
      accountRef.current = next;
      setAccount(next);
      return true;
    } catch (e) {
      notify("Couldn't save — " + (e?.message || "check your connection and try again."), "err");
      return false;
    }
  }, [authUser, notify]);

  // Called from the Upgrade screen once the owner has paid via PayMongo (or
  // manually — see MANUAL_PAYMENT_NOTE). There's no PayMongo webhook wired
  // up here (that needs a small server function — see supabase-schema.sql's
  // notes), so this is a self-reported confirmation: it flips
  // subscription_status to "active", starts a new SUBSCRIPTION_PERIOD_DAYS
  // period, and stores whatever reference the owner typed in, for you to
  // reconcile against PayMongo's dashboard.
  const markSubscriptionActive = useCallback(async (referenceNote) => {
    if (!authUser) return false;
    // First payment ever (was still on "trial") vs. a renewal of an
    // already-active account. Only a first payment can be discounted by the
    // one-time referral signup discount — and once used, it's gone for
    // good, so it doesn't silently reapply to every future renewal.
    const isFirstPayment = accountRef.current?.subscriptionStatus !== "active";
    const periodEnd = new Date(Date.now() + SUBSCRIPTION_PERIOD_DAYS * MS_PER_DAY).toISOString();
    // Every time a billing cycle starts (first payment OR a renewal), the
    // 3% referral reward credit resets back to 0% for the new month — it
    // does not accumulate or roll over. Fresh referrals made DURING the new
    // cycle build the credit back up toward the *next* bill.
    const updates = {
      subscription_status: "active",
      subscription_period_end: periodEnd,
      payment_reference: referenceNote || null,
      reward_credits: 0,
    };
    if (isFirstPayment) updates.discount_percent = 0;
    const { error } = await supabase.from("businesses").update(updates).eq("id", authUser.id);
    if (error) {
      notify("Couldn't confirm the upgrade — " + error.message, "err");
      return false;
    }
    const next = {
      ...(accountRef.current || {}),
      subscriptionStatus: "active",
      subscriptionPeriodEnd: periodEnd,
      paymentReference: referenceNote || "",
      discountPercent: isFirstPayment ? 0 : (accountRef.current?.discountPercent || 0),
      rewardCredits: 0,
    };
    accountRef.current = next;
    setAccount(next);

    // Actually "spend" any referral code that was applied-but-not-yet-paid
    // (pending_referral_code) — this is the ONLY moment a code is ever
    // marked used, for both this account and the referrer, and it's why a
    // code clicked "Apply" and then abandoned never blocks a later, real
    // attempt. Also credits this person's referrer (if any) with their
    // one-time 3% reward — but only now, on an actual confirmed FIRST
    // payment, never at code-apply time. See finalize_referral_redemption()
    // in the SQL setup block at the top of this file, which is also the
    // real enforcement: it's a no-op if this account never applied a code,
    // and a safe no-op if this exact referral was somehow already finalized
    // before (so this can never double-credit a referrer or double-count a
    // redemption, even if this function ever runs twice for the same first
    // payment). Deliberately fire-and-forget with respect to the UI: if
    // this call fails, the subscriber's own upgrade has still fully
    // succeeded above, so we log the failure for debugging rather than
    // showing the subscriber an error about someone else's reward credit.
    if (isFirstPayment) {
      supabase.rpc("finalize_referral_redemption").then(({ error: rewardErr }) => {
        if (rewardErr) console.error("finalize_referral_redemption failed:", rewardErr);
      });
    }

    notify(isFirstPayment ? "You're upgraded — thanks for subscribing!" : "Renewed — thanks for staying with us! Your reward credit has reset to 0% for the new billing cycle.");
    return true;
  }, [authUser, notify]);

  // Applies a referral/discount code from the Subscribe popup, for an owner
  // who's already signed in, before their first payment (unlike the old
  // signup-time flow, this can be used any time before they pay — but only
  // before that first payment; see redeem_referral() in the SQL setup block
  // at the top of this file, which is the actual source of truth for all of
  // this, since a client can't be trusted to award itself a discount).
  // Applying a code only ever previews the discount and queues the code up
  // (pending_referral_code) — it does NOT "use up" the code. The code is
  // only actually spent, for the caller and the referrer, once payment is
  // confirmed (see finalize_referral_redemption(), called from
  // markSubscriptionActive() below). That means this can be called again
  // freely — the same code or a different one — any number of times before
  // the owner actually pays, with zero side effects either way.
  // Returns `true` on success, or an error STRING the popup can show
  // directly (e.g. "Invalid referral code").
  const applyReferralCode = useCallback(async (code) => {
    if (!authUser) return "You need to be logged in to apply a code.";
    const clean = (code || "").trim();
    if (!clean) return "Enter a code first.";
    // Fast, friendly client-side check for the obvious case (typing your
    // own code) — redeem_referral() still enforces this for real server-side,
    // including the same check by email, so this is just a quicker "no".
    if (accountRef.current?.referralCode && clean.toUpperCase() === accountRef.current.referralCode.toUpperCase()) {
      return "That's your own referral code — it can't be used on your own account.";
    }
    // Everything below talks to Supabase over the network, so anything
    // here can throw (offline, DNS hiccup, the redeem_referral() SQL
    // function not having been created yet in this project — see the
    // ONE-TIME SUPABASE SETUP block at the top of this file, timeouts,
    // etc). Previously an exception here had no catch anywhere in the
    // call chain (see applyCode() in UpgradeView), so it silently died —
    // no toast, no error text, sometimes even leaving the Apply button
    // stuck disabled. Wrapping it means the person always sees SOME
    // message instead of the UI just doing nothing.
    try {
      const { error } = await supabase.rpc("redeem_referral", { p_code: clean.toUpperCase() });
      if (error) return error.message || "That code isn't valid.";

      // The RPC just committed discount_percent = 25 (a preview only — the
      // code itself isn't spent yet, see redeem_referral() in the SQL setup
      // block) server-side — that part is already a
      // known, guaranteed fact the instant this line runs. Reflect it in the
      // UI right away instead of waiting on a second network round-trip
      // (fetchBusiness below) to tell us what we already know. Previously,
      // if that second call ever came back empty or failed (a network
      // hiccup, brief replication lag, anything), the success toast still
      // fired but the price on screen silently never updated — this
      // optimistic update means the discount always shows immediately,
      // regardless of what happens to the follow-up fetch.
      const optimistic = { ...(accountRef.current || {}), discountPercent: REFERRAL_DISCOUNT_PERCENT };
      accountRef.current = optimistic;
      setAccount(optimistic);

      // Best-effort background refresh, to pick up anything else the RPC
      // changed (referredBy, etc.) and to correct the optimistic value above
      // in the rare case the real discount ever differs from the constant.
      // If this fails or returns nothing, the optimistic update above still
      // stands, so the price never regresses back to "no discount".
      let biz = null;
      try {
        biz = await fetchBusiness(authUser.id);
      } catch (fetchErr) {
        console.error("Referral applied, but refreshing the account afterward failed:", fetchErr);
        // Not fatal — the optimistic update above already shows the
        // discount correctly, so we deliberately don't surface this as an
        // error to the person.
      }
      if (biz) {
        accountRef.current = biz;
        setAccount(biz);
      }
      notify(`Code applied — you'll get ${biz?.discountPercent || REFERRAL_DISCOUNT_PERCENT}% off your first payment. This is confirmed once you complete payment.`);
      return true;
    } catch (err) {
      console.error("applyReferralCode failed:", err);
      return err?.message || "Couldn't reach the server — check your connection and try again.";
    }
  }, [authUser, notify, fetchBusiness]);

  const persistEmployees = useCallback(async (next) => {
    setEmployees(next);
    const ok = await safeSet(scopedKey(EMPLOYEES_KEY, authUserIdRef.current), next);
    if (!ok) notify("Couldn't save employees — check connection and try again.", "err");
  }, [notify]);

  const selectEmployee = useCallback(async (id) => {
    setCurrentEmployeeId(id);
    const ok = await safeSet(scopedKey(CURRENT_EMPLOYEE_KEY, authUserIdRef.current), id);
    if (!ok) notify("Couldn't switch employee — check connection and try again.", "err");
  }, [notify]);

  const persistShifts = useCallback(async (next) => {
    setShifts(next);
    const ok = await safeSet(scopedKey(SHIFTS_KEY, authUserIdRef.current), next);
    if (!ok) notify("Couldn't save shift data — check connection and try again.", "err");
  }, [notify]);

  const persistWaste = useCallback(async (next) => {
    setWasteLogs(next);
    const ok = await safeSet(scopedKey(WASTE_KEY, authUserIdRef.current), next);
    if (!ok) notify("Couldn't save the waste log — check connection and try again.", "err");
  }, [notify]);

  const addEmployee = (name, role = "staff", pin = "") => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (employees.some((e) => e.name.toLowerCase() === trimmed.toLowerCase())) {
      notify("That employee is already on the list.", "err");
      return;
    }
    const trimmedPin = (pin || "").trim();
    if (trimmedPin && !/^\d{4}$/.test(trimmedPin)) {
      notify("PIN must be exactly 4 digits.", "err");
      return;
    }
    const emp = { id: uid("emp"), name: trimmed, role: role === "manager" ? "manager" : "staff", pin: trimmedPin };
    const next = [...employees, emp];
    persistEmployees(next);
    requestEmployeeChange(emp.id);
    notify("Employee added.");
  };
  // Managers approving a void/restore have to enter this PIN, so it's the
  // one piece of employee data that gets its own save action instead of
  // going through the full edit form.
  const updateEmployeePin = (id, pin) => {
    const trimmed = (pin || "").trim();
    if (trimmed && !/^\d{4}$/.test(trimmed)) {
      notify("PIN must be exactly 4 digits.", "err");
      return;
    }
    persistEmployees(employees.map((e) => (e.id === id ? { ...e, pin: trimmed } : e)));
    notify(trimmed ? "PIN saved." : "PIN cleared.");
  };
  const removeEmployee = (id) => {
    if (employees.length <= 1) { notify("Keep at least one employee.", "err"); return; }
    const next = employees.filter((e) => e.id !== id);
    persistEmployees(next);
    if (currentEmployeeId === id) selectEmployee(next[0].id);
    notify("Employee removed.");
  };
  const currentEmployee = employees.find((e) => e.id === currentEmployeeId) || null;
  // Void AND restore approvals must be signed off by a manager — no fallback
  // to staff, so this list is empty until at least one manager is on file.
  const approverOptions = employees.filter((e) => e.role === "manager");

  const persistCatalog = useCallback(async (next) => {
    setCatalog(next);
    const ok = await safeSet(scopedKey(CATALOG_KEY, authUserIdRef.current), next);
    if (!ok) notify("Couldn't save — check connection and try again.", "err");
  }, [notify]);

  // Purges anything older than RETENTION_MONTHS on every single save (not
  // just on initial page load) — so if the POS is left open across a
  // month-end, older sales still get dropped promptly instead of quietly
  // piling up until the next reload.
  const persistSales = useCallback(async (next) => {
    const trimmed = purgeOldSales(next);
    setSales(trimmed);
    const ok = await safeSet(scopedKey(SALES_KEY, authUserIdRef.current), trimmed);
    if (!ok) notify("Couldn't save the sale — check connection and try again.", "err");
  }, [notify]);

  // No retention purge here — open tabs are actively managed (settled or
  // cancelled), not a growing history log the way sales are.
  const persistParkedOrders = useCallback(async (next) => {
    setParkedOrders(next);
    const ok = await safeSet(scopedKey(PARKED_ORDERS_KEY, authUserIdRef.current), next);
    if (!ok) notify("Couldn't save the tab — check connection and try again.", "err");
  }, [notify]);

  const ingredientMap = useMemo(
    () => Object.fromEntries(catalog.ingredients.map((i) => [i.id, i])),
    [catalog.ingredients]
  );
  const lowStock = useMemo(
    () => catalog.ingredients.filter((i) => i.low > 0 && i.stock <= i.low),
    [catalog.ingredients]
  );

  const productCost = useCallback((product) => {
    return product.recipe.reduce((sum, r) => {
      const ing = ingredientMap[r.ingredientId];
      return sum + (ing ? ing.cost * r.amount : 0);
    }, 0);
  }, [ingredientMap]);

  // ---------- Ingredient CRUD ----------
  const saveIngredient = (data, editingId) => {
    let next;
    if (editingId) {
      next = { ...catalog, ingredients: catalog.ingredients.map((i) => (i.id === editingId ? { ...i, ...data } : i)) };
    } else {
      next = { ...catalog, ingredients: [...catalog.ingredients, { id: uid("ing"), ...data }] };
    }
    persistCatalog(next);
    setIngModal(null);
    notify(editingId ? "Ingredient updated." : "Ingredient added.");
  };
  const deleteIngredient = (id) => {
    const used = catalog.products.some((p) => p.recipe.some((r) => r.ingredientId === id));
    if (used) { notify("Can't delete — this ingredient is used in a product recipe.", "err"); return; }
    persistCatalog({ ...catalog, ingredients: catalog.ingredients.filter((i) => i.id !== id) });
    notify("Ingredient removed.");
  };
  const applyRestock = (id) => {
    const amt = parseFloat(restockVal);
    if (!amt || amt <= 0) { setRestockId(null); setRestockVal(""); return; }
    const next = {
      ...catalog,
      ingredients: catalog.ingredients.map((i) => (i.id === id ? { ...i, stock: +(i.stock + amt).toFixed(2) } : i)),
    };
    persistCatalog(next);
    notify(`Restocked +${amt}.`);
    setRestockId(null);
    setRestockVal("");
  };

  // ---------- Waste / spoilage ----------
  // Stock lost before it ever became a sale (spoilage, breakage, staff
  // meals) — logged separately from voids so inventory numbers stay honest
  // even for shrinkage that never touched an order.
  const logWaste = (ingredientId, amount, reason, note) => {
    const amt = parseFloat(amount);
    const ing = catalog.ingredients.find((i) => i.id === ingredientId);
    if (!ing || !amt || amt <= 0) { notify("Enter an ingredient and a positive amount.", "err"); return; }
    const nextIngredients = catalog.ingredients.map((i) =>
      i.id === ingredientId ? { ...i, stock: Math.max(0, +(i.stock - amt).toFixed(2)) } : i
    );
    persistCatalog({ ...catalog, ingredients: nextIngredients });
    const entry = {
      id: uid("waste"),
      timestamp: Date.now(),
      ingredientId,
      ingredientName: ing.name,
      unit: ing.unit,
      amount: amt,
      reason: reason || WASTE_REASONS[0],
      note: (note || "").trim(),
      cost: +(ing.cost * amt).toFixed(2),
      loggedById: currentEmployee?.id || null,
      loggedByName: currentEmployee?.name || "Unassigned",
    };
    persistWaste([...wasteLogs, entry]);
    setWasteModal(false);
    notify("Waste logged — stock updated.");
  };

  // Log waste for a whole finished product (e.g. "dropped a Vanilla Latte")
  // instead of a raw ingredient. Scales the product's recipe by qty, deducts
  // every ingredient it uses, and records one waste entry per ingredient so
  // the existing per-ingredient reporting (cost by reason, etc.) doesn't need
  // to change — the entries are tied together with a shared batchId and each
  // carries the product's name so the waste log can show what they were for.
  const logProductWaste = (productId, qty, reason, note) => {
    const q = parseFloat(qty);
    const product = catalog.products.find((p) => p.id === productId);
    if (!product || !q || q <= 0) { notify("Enter a product and a positive quantity.", "err"); return; }
    if (!product.recipe || product.recipe.length === 0) {
      notify("That product has no recipe set, so there's nothing to deduct.", "err");
      return;
    }
    const batchId = uid("wbatch");
    const trimmedNote = (note || "").trim();
    const entries = [];
    const nextIngredients = catalog.ingredients.map((i) => {
      const line = product.recipe.find((r) => r.ingredientId === i.id);
      if (!line) return i;
      const amt = +(line.amount * q).toFixed(4);
      entries.push({
        id: uid("waste"),
        timestamp: Date.now(),
        batchId,
        ingredientId: i.id,
        ingredientName: i.name,
        unit: i.unit,
        amount: amt,
        reason: reason || WASTE_REASONS[0],
        note: trimmedNote,
        cost: +(i.cost * amt).toFixed(2),
        loggedById: currentEmployee?.id || null,
        loggedByName: currentEmployee?.name || "Unassigned",
        productId: product.id,
        productName: product.name,
        productQty: q,
      });
      return { ...i, stock: Math.max(0, +(i.stock - amt).toFixed(2)) };
    });
    // Recipe lines whose ingredient no longer exists in the catalog are
    // silently skipped above (nothing to deduct); still log them so the cost
    // isn't understated, just without a stock change.
    product.recipe.forEach((line) => {
      if (!catalog.ingredients.some((i) => i.id === line.ingredientId)) {
        entries.push({
          id: uid("waste"),
          timestamp: Date.now(),
          batchId,
          ingredientId: line.ingredientId,
          ingredientName: "Deleted ingredient",
          unit: "",
          amount: +(line.amount * q).toFixed(4),
          reason: reason || WASTE_REASONS[0],
          note: trimmedNote,
          cost: 0,
          loggedById: currentEmployee?.id || null,
          loggedByName: currentEmployee?.name || "Unassigned",
          productId: product.id,
          productName: product.name,
          productQty: q,
        });
      }
    });
    persistCatalog({ ...catalog, ingredients: nextIngredients });
    persistWaste([...wasteLogs, ...entries]);
    setWasteModal(false);
    notify(`Waste logged — ${q}× ${product.name}, ingredients deducted.`);
  };

  // ---------- Shifts (X/Z report) ----------
  // Only one shift can be open at a time. Opening records the starting float;
  // closing counts the drawer and compares it to what should be there
  // (opening float + cash collected during the shift, split-payment cash
  // legs included) so discrepancies surface per shift, not just per report.
  const activeShift = useMemo(() => shifts.find((s) => !s.closedAt) || null, [shifts]);
  const shiftCashSoFar = useCallback((shift) => {
    if (!shift) return 0;
    const end = shift.closedAt || Date.now();
    return sales
      .filter((s) => s.timestamp >= shift.openedAt && s.timestamp <= end)
      .reduce((sum, s) => sum + saleCashAmount(s), 0);
  }, [sales]);
  // Online total collected during the shift (GCash/card/etc, including the
  // online leg of any split payments) — shown alongside the cash count so
  // closing out gives a full picture of the shift's sales, not just the drawer.
  const shiftOnlineSoFar = useCallback((shift) => {
    if (!shift) return 0;
    const end = shift.closedAt || Date.now();
    return sales
      .filter((s) => s.timestamp >= shift.openedAt && s.timestamp <= end)
      .reduce((sum, s) => sum + saleOnlineAmount(s), 0);
  }, [sales]);
  const openShift = (openingFloat) => {
    if (activeShift) { notify("A shift is already open.", "err"); return; }
    const amt = parseFloat(openingFloat);
    if (isNaN(amt) || amt < 0) { notify("Enter a valid opening float.", "err"); return; }
    const shift = {
      id: uid("shift"),
      openedAt: Date.now(),
      openedById: currentEmployee?.id || null,
      openedByName: currentEmployee?.name || "Unassigned",
      openingFloat: amt,
      closedAt: null,
      closedById: null,
      closedByName: null,
      countedCash: null,
      cashCollected: null,
      onlineCollected: null,
      expectedCash: null,
      variance: null,
      note: "",
    };
    persistShifts([...shifts, shift]);
    notify(`Shift started with ${money(amt)} float.`);
  };
  // Shared by a manual "close shift" and an employee handoff — counts a
  // shift's drawer against what it should hold and returns the closed
  // record, or null if the count wasn't a valid number.
  const buildClosedShift = useCallback((shift, countedCash, note, closerName, closerId) => {
    const counted = parseFloat(countedCash);
    if (isNaN(counted) || counted < 0) return null;
    const cashCollected = shiftCashSoFar(shift);
    const onlineCollected = shiftOnlineSoFar(shift);
    const expectedCash = +(shift.openingFloat + cashCollected).toFixed(2);
    const variance = +(counted - expectedCash).toFixed(2);
    return {
      ...shift,
      closedAt: Date.now(),
      closedById: closerId || null,
      closedByName: closerName || "Unassigned",
      countedCash: counted,
      cashCollected,
      onlineCollected,
      expectedCash,
      variance,
      note: (note || "").trim(),
    };
  }, [shiftCashSoFar, shiftOnlineSoFar]);
  const closeShift = (countedCash, note) => {
    if (!activeShift) return;
    const updated = buildClosedShift(activeShift, countedCash, note, currentEmployee?.name, currentEmployee?.id);
    if (!updated) { notify("Enter what you counted in the drawer.", "err"); return; }
    persistShifts(shifts.map((s) => (s.id === activeShift.id ? updated : s)));
    setShiftCloseModal(false);
    notify(
      updated.variance === 0
        ? "Shift closed — drawer matched exactly."
        : `Shift closed — ${updated.variance > 0 ? "over" : "short"} by ${money(Math.abs(updated.variance))}.`
    );
  };
  // Every employee change routes through here instead of calling
  // selectEmployee directly. If a shift is open, it doesn't switch right
  // away — it opens the handoff modal so the outgoing employee's drawer
  // gets counted and closed out before the incoming one starts their own
  // shift, so every shift's cash is accountable to exactly one person.
  const requestEmployeeChange = useCallback((id) => {
    if (!id || id === currentEmployeeId) return;
    if (activeShift) { setPendingEmployeeSwitch(id); return; }
    selectEmployee(id);
  }, [currentEmployeeId, activeShift, selectEmployee]);
  const pendingEmployee = employees.find((e) => e.id === pendingEmployeeSwitch) || null;
  const confirmHandoff = (countedCash, note, openingFloat) => {
    if (!activeShift || !pendingEmployee) return;
    const closed = buildClosedShift(activeShift, countedCash, note, currentEmployee?.name, currentEmployee?.id);
    if (!closed) { notify("Enter what you counted in the drawer.", "err"); return; }
    const floatAmt = parseFloat(openingFloat);
    if (isNaN(floatAmt) || floatAmt < 0) { notify("Enter a valid opening float for the incoming employee.", "err"); return; }
    const newShift = {
      id: uid("shift"),
      openedAt: Date.now(),
      openedById: pendingEmployee.id,
      openedByName: pendingEmployee.name,
      openingFloat: floatAmt,
      closedAt: null,
      closedById: null,
      closedByName: null,
      countedCash: null,
      cashCollected: null,
      onlineCollected: null,
      expectedCash: null,
      variance: null,
      note: "",
    };
    persistShifts([...shifts.map((s) => (s.id === activeShift.id ? closed : s)), newShift]);
    selectEmployee(pendingEmployee.id);
    setPendingEmployeeSwitch(null);
    notify(
      closed.variance === 0
        ? `Handed off to ${pendingEmployee.name} — drawer matched, new shift started with ${money(floatAmt)} float.`
        : `Handed off to ${pendingEmployee.name} — ${closed.variance > 0 ? "over" : "short"} by ${money(Math.abs(closed.variance))}. New shift started with ${money(floatAmt)} float.`
    );
  };

  // ---------- Product CRUD ----------
  const saveProduct = (data, editingId) => {
    let next;
    if (editingId) {
      next = { ...catalog, products: catalog.products.map((p) => (p.id === editingId ? { ...p, ...data } : p)) };
    } else {
      next = { ...catalog, products: [...catalog.products, { id: uid("prod"), ...data }] };
    }
    persistCatalog(next);
    setProdModal(null);
    notify(editingId ? "Product updated." : "Product added.");
  };
  const deleteProduct = (id) => {
    persistCatalog({ ...catalog, products: catalog.products.filter((p) => p.id !== id) });
    setCart((c) => c.filter((c2) => c2.productId !== id));
    notify("Product removed.");
  };

  // ---------- Category CRUD ----------
  const addCategory = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (catalog.categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      notify("That category already exists.", "err");
      return;
    }
    persistCatalog({ ...catalog, categories: [...catalog.categories, { id: uid("cat"), name: trimmed }] });
    notify("Category added.");
  };
  const deleteCategory = (id) => {
    if (catalog.categories.length <= 1) { notify("Keep at least one category.", "err"); return; }
    const used = catalog.products.some((p) => p.category === id);
    if (used) { notify("Can't delete — some products use this category.", "err"); return; }
    persistCatalog({ ...catalog, categories: catalog.categories.filter((c) => c.id !== id) });
    if (posFilter === id) setPosFilter("all");
    notify("Category removed.");
  };

  // ---------- Cart / checkout ----------
  const addToCart = (productId) => {
    setCheckoutError(null);
    setCart((c) => {
      const found = c.find((i) => i.productId === productId);
      if (found) return c.map((i) => (i.productId === productId ? { ...i, qty: i.qty + 1 } : i));
      return [...c, { productId, qty: 1 }];
    });
  };
  const changeQty = (productId, delta) => {
    setCheckoutError(null);
    setCart((c) =>
      c
        .map((i) => (i.productId === productId ? { ...i, qty: Math.max(0, i.qty + delta) } : i))
        .filter((i) => i.qty > 0)
    );
  };
  const removeFromCart = (productId) => setCart((c) => c.filter((i) => i.productId !== productId));
  const clearCart = () => {
    setCart([]);
    setCheckoutError(null);
    setCashReceived("");
    setSplitItemLegs({});
    setDiscountType("none");
    setDiscountValue("");
    setPaymentProof(null);
  };

  const uploadPaymentProof = async (file) => {
    if (!file) return;
    setProofProcessing(true);
    try {
      const dataUrl = await fileToResizedDataURL(file);
      setPaymentProof(dataUrl);
    } catch {
      notify("Couldn't read that image — try a different file.", "err");
    } finally {
      setProofProcessing(false);
    }
  };

  const cartDetailed = useMemo(
    () => cart
      .map((i) => ({ ...i, product: catalog.products.find((p) => p.id === i.productId) }))
      .filter((i) => i.product),
    [cart, catalog.products]
  );
  const subtotal = useMemo(() => cartDetailed.reduce((s, i) => s + i.product.price * i.qty, 0), [cartDetailed]);
  const discountAmount = useMemo(() => {
    const v = parseFloat(discountValue) || 0;
    if (v <= 0) return 0;
    if (discountType === "percent") return Math.min(subtotal, (subtotal * v) / 100);
    if (discountType === "amount") return Math.min(subtotal, v);
    return 0;
  }, [discountType, discountValue, subtotal]);
  const cartTotal = Math.max(0, +(subtotal - discountAmount).toFixed(2));
  const changeDue = paymentMethod === "cash" ? +((parseFloat(cashReceived) || 0) - cartTotal).toFixed(2) : 0;
  // Resolve each split leg to a concrete { method, amount }.
  // - "amount" mode: legs except the last are manually typed; the last leg
  //   always takes the remainder of the total (never negative).
  // - "items" mode: each leg's amount is the sum of the cart lines assigned
  //   to it (discount applied proportionally to each leg's share of the
  //   subtotal), with the same last-leg-takes-the-remainder trick used so
  //   rounding never leaves the legs a cent off the real total.
  const splitPaymentsResolved = (() => {
    if (paymentMethod !== "split") return [];
    if (splitMode === "items") {
      const legSubtotals = splitPayments.map(() => 0);
      cartDetailed.forEach((item) => {
        const legIdx = splitItemLegs[item.productId] ?? 0;
        const idx = legIdx < legSubtotals.length ? legIdx : 0;
        legSubtotals[idx] += item.product.price * item.qty;
      });
      const raw = legSubtotals.map((legSubtotal) =>
        subtotal > 0 ? legSubtotal - discountAmount * (legSubtotal / subtotal) : 0
      );
      const rounded = raw.map((a, idx) => (idx === raw.length - 1 ? 0 : Math.max(0, +a.toFixed(2))));
      const sumOthers = rounded.slice(0, -1).reduce((s, a) => s + a, 0);
      rounded[rounded.length - 1] = Math.max(0, +(cartTotal - sumOthers).toFixed(2));
      return splitPayments.map((p, idx) => ({ method: p.method, amount: rounded[idx] }));
    }
    const manualTotal = splitPayments.slice(0, -1).reduce((s, p) => s + Math.max(0, parseFloat(p.amount) || 0), 0);
    const lastAmount = Math.max(0, +(cartTotal - manualTotal).toFixed(2));
    return splitPayments.map((p, idx) => ({
      method: p.method,
      amount: idx === splitPayments.length - 1 ? lastAmount : +Math.max(0, parseFloat(p.amount) || 0).toFixed(2),
    }));
  })();
  const addSplitLine = () => {
    setSplitPayments((prev) => [
      ...prev,
      { method: prev[prev.length - 1].method === "cash" ? "online" : "cash", amount: "" },
    ]);
  };
  const removeSplitLine = (idx) => {
    if (splitPayments.length <= 2) return;
    setSplitPayments((prev) => prev.filter((_, i) => i !== idx));
    // Items assigned to the removed leg fall back to the first leg; items on
    // legs after it shift down an index so assignments stay pointed correctly.
    setSplitItemLegs((prev) => {
      const next = {};
      Object.entries(prev).forEach(([pid, legIdx]) => {
        const li = Number(legIdx);
        next[pid] = li === idx ? 0 : li > idx ? li - 1 : li;
      });
      return next;
    });
  };
  const updateSplitMethod = (idx, method) => {
    setSplitPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, method } : p)));
  };
  const updateSplitAmount = (idx, amount) => {
    setSplitPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, amount } : p)));
  };
  const assignSplitItem = (productId, legIdx) => {
    setSplitItemLegs((prev) => ({ ...prev, [productId]: legIdx }));
  };

  const checkout = () => {
    if (cartDetailed.length === 0) return;
    if (!activeShift) { notify("Open a shift before checking out.", "err"); return; }
    // aggregate ingredient needs
    const needs = {};
    cartDetailed.forEach(({ product, qty }) => {
      product.recipe.forEach((r) => {
        needs[r.ingredientId] = (needs[r.ingredientId] || 0) + r.amount * qty;
      });
    });
    const shortages = Object.entries(needs)
      .map(([ingId, needed]) => {
        const ing = ingredientMap[ingId];
        if (!ing) return null;
        return needed > ing.stock ? { name: ing.name, needed, available: ing.stock, unit: ing.unit } : null;
      })
      .filter(Boolean);
    if (shortages.length) {
      setCheckoutError({ kind: "stock", shortages });
      return;
    }
    if (paymentMethod === "cash" && (parseFloat(cashReceived) || 0) < cartTotal) {
      setCheckoutError({ kind: "cash", message: "Cash received is less than the total due." });
      return;
    }
    if (paymentMethod === "split") {
      const allLegsCovered = splitPaymentsResolved.length >= 2 && splitPaymentsResolved.every((p) => p.amount > 0);
      if (!allLegsCovered) {
        setCheckoutError({
          kind: "cash",
          message: splitMode === "items"
            ? "Assign at least one item to each payment so every payment has something to cover."
            : "Enter payment amounts that add up to less than the total, with something left over for the last payment.",
        });
        return;
      }
    }
    const nextIngredients = catalog.ingredients.map((i) =>
      needs[i.id] ? { ...i, stock: +(i.stock - needs[i.id]).toFixed(2) } : i
    );
    const nextCatalog = { ...catalog, ingredients: nextIngredients };
    const saleItems = cartDetailed.map(({ product, qty }) => ({
      productId: product.id,
      name: product.name,
      category: product.category,
      qty,
      price: product.price,
      cost: productCost(product),
      // Snapshot the recipe used at time of sale (per single unit), so a later
      // void/restore always reverses exactly what was deducted here — even if
      // the product's recipe gets edited afterward.
      recipe: product.recipe.map((r) => ({ ingredientId: r.ingredientId, amount: r.amount })),
      voided: false,
      prepared: false,
    }));
    const amountTendered = paymentMethod === "cash" ? (parseFloat(cashReceived) || 0) : cartTotal;
    const totalCost = saleItems.reduce((s, i) => s + i.cost * i.qty, 0);
    // Split payments carry a fixed breakdown of legs (each independently cash
    // or online) decided at checkout; `originalPayments` is kept untouched
    // for audit the same way the other original* fields are, since
    // `payments` isn't rebalanced by later voids.
    const payments = paymentMethod === "split" ? splitPaymentsResolved : null;
    const sale = {
      id: uid("sale"),
      orderNo: nextOrderNo,
      timestamp: Date.now(),
      employeeId: currentEmployee?.id || null,
      employeeName: currentEmployee?.name || "Unassigned",
      shiftId: activeShift?.id || null,
      // Drives the Kitchen board: fresh orders start "preparing" and move to
      // "completed" once every item's checked off (or a staff override).
      status: "preparing",
      completedAt: null,
      items: saleItems,
      subtotal,
      // Original amounts are kept untouched for audit/receipt display even if
      // items are later partially voided and subtotal/total/totalCost below get
      // recomputed to reflect only what's still active.
      originalSubtotal: subtotal,
      originalDiscountAmount: discountAmount,
      originalTotal: cartTotal,
      originalTotalCost: totalCost,
      discountType,
      discountValue: parseFloat(discountValue) || 0,
      discountAmount,
      total: cartTotal,
      totalCost,
      paymentMethod,
      payments,
      originalPayments: payments,
      amountTendered,
      change: paymentMethod === "cash" ? +(amountTendered - cartTotal).toFixed(2) : 0,
      paymentProof: (paymentMethod === "online" || paymentMethod === "split") ? paymentProof : null,
      voided: false,
      voidReason: null,
      voidNote: "",
      voidedAt: null,
    };

    persistCatalog(nextCatalog);
    persistSales([...sales, sale]);
    setNextOrderNo((n) => n + 1);
    safeSet(ORDER_COUNTER_KEY, nextOrderNo + 1);
    setCart([]);
    setCheckoutError(null);
    setCashReceived("");
    setSplitPayments([{ method: "cash", amount: "" }, { method: "online", amount: "" }]);
    setSplitMode("amount");
    setSplitItemLegs({});
    setDiscountType("none");
    setDiscountValue("");
    setPaymentProof(null);
    setReceipt(sale);
  };

  // ---------- Tabs (parked orders) ----------
  // A tab is a cart that's already been sent to the kitchen — ingredients
  // are deducted the moment an item is added to it, exactly like a normal
  // checkout — but payment is deferred. Typical use: a table orders,
  // eats, maybe orders more, then pays everything at once before leaving.
  // Kept as its own array (parkedOrders) rather than mixed into `sales`, so
  // nothing about Reports/History/exports has to special-case "unpaid"
  // sales — a tab only becomes a `sale` (and only then counts toward
  // revenue) once settleTab() below actually charges it.
  //
  // Shared shortage-check + stock-deduction helper used by both parking a
  // whole cart and adding one more item to an already-open tab — same logic
  // checkout() uses, just factored out so both call sites stay in sync.
  const deductStockFor = (lineItems) => {
    const needs = {};
    lineItems.forEach(({ product, qty }) => {
      product.recipe.forEach((r) => {
        needs[r.ingredientId] = (needs[r.ingredientId] || 0) + r.amount * qty;
      });
    });
    const shortages = Object.entries(needs)
      .map(([ingId, needed]) => {
        const ing = ingredientMap[ingId];
        if (!ing) return null;
        return needed > ing.stock ? { name: ing.name, needed, available: ing.stock, unit: ing.unit } : null;
      })
      .filter(Boolean);
    if (shortages.length) return { ok: false, shortages };
    const nextIngredients = catalog.ingredients.map((i) =>
      needs[i.id] ? { ...i, stock: +(i.stock - needs[i.id]).toFixed(2) } : i
    );
    persistCatalog({ ...catalog, ingredients: nextIngredients });
    return { ok: true };
  };
  // Reverses deductStockFor for a single line (e.g. removing an item from a
  // tab, or reducing its qty) — returns those ingredients to stock.
  const restockFor = (recipe, qty) => {
    if (!recipe || !recipe.length) return;
    const nextIngredients = catalog.ingredients.map((i) => {
      const r = recipe.find((x) => x.ingredientId === i.id);
      return r ? { ...i, stock: +(i.stock + r.amount * qty).toFixed(2) } : i;
    });
    persistCatalog({ ...catalog, ingredients: nextIngredients });
  };

  const parkOrder = (label) => {
    if (cartDetailed.length === 0) return;
    if (!activeShift) { notify("Open a shift before starting a tab.", "err"); return; }
    const result = deductStockFor(cartDetailed);
    if (!result.ok) {
      setCheckoutError({ kind: "stock", shortages: result.shortages });
      return;
    }
    const items = cartDetailed.map(({ product, qty }) => ({
      productId: product.id,
      name: product.name,
      category: product.category,
      qty,
      price: product.price,
      cost: productCost(product),
      recipe: product.recipe.map((r) => ({ ingredientId: r.ingredientId, amount: r.amount })),
      prepared: false,
    }));
    const tab = {
      id: uid("tab"),
      orderNo: nextOrderNo,
      label: (label || "").trim() || `Tab #${nextOrderNo}`,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      employeeId: currentEmployee?.id || null,
      employeeName: currentEmployee?.name || "Unassigned",
      shiftId: activeShift?.id || null,
      items,
      // Mirrors a sale's status/completedAt (see Kitchen board below) so a
      // tab can be checked off as done — crossed out, moved to a
      // "Completed" list — the same way a normal kitchen order can, even
      // though it's still unpaid. Kept independent of `sales`/checkout;
      // settling the bill later doesn't require this to be "completed".
      status: "preparing",
      completedAt: null,
    };
    persistParkedOrders([...parkedOrders, tab]);
    setNextOrderNo((n) => n + 1);
    safeSet(ORDER_COUNTER_KEY, nextOrderNo + 1);
    setCart([]);
    setCheckoutError(null);
    setParkModalOpen(false);
    notify(`Tab "${tab.label}" opened — order #${tab.orderNo}.`);
  };

  const addItemToTab = (tabId, productId) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    const product = catalog.products.find((p) => p.id === productId);
    if (!tab || !product) return;
    const result = deductStockFor([{ product, qty: 1 }]);
    if (!result.ok) {
      notify(`Not enough stock for ${product.name} (need more ${result.shortages.map((s) => s.name).join(", ")}).`, "err");
      return;
    }
    const existing = tab.items.find((it) => it.productId === productId);
    const items = existing
      ? tab.items.map((it) => (it.productId === productId ? { ...it, qty: it.qty + 1 } : it))
      : [
          ...tab.items,
          {
            productId: product.id,
            name: product.name,
            category: product.category,
            qty: 1,
            price: product.price,
            cost: productCost(product),
            recipe: product.recipe.map((r) => ({ ingredientId: r.ingredientId, amount: r.amount })),
            prepared: false,
          },
        ];
    // Adding a fresh (unprepared) item to a tab that was already marked
    // "completed" reopens it — the crossed-out/Completed state shouldn't
    // silently hide a brand-new item that hasn't been made yet.
    const reopening = tab.status === "completed";
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? {
      ...t,
      items,
      updatedAt: Date.now(),
      status: reopening ? "preparing" : t.status,
      completedAt: reopening ? null : t.completedAt,
    } : t)));
    if (reopening) notify(`Tab "${tab.label}" reopened — new item added.`);
  };

  // delta is always -1 here (the +1 case is addItemToTab, which also
  // handles a brand-new line item) — reducing qty to 0 removes the line.
  const decrementTabItem = (tabId, productId) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    if (!tab) return;
    const item = tab.items.find((it) => it.productId === productId);
    if (!item) return;
    restockFor(item.recipe, 1);
    const items = item.qty <= 1
      ? tab.items.filter((it) => it.productId !== productId)
      : tab.items.map((it) => (it.productId === productId ? { ...it, qty: it.qty - 1 } : it));
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? { ...t, items, updatedAt: Date.now() } : t)));
  };

  const removeTabItem = (tabId, productId) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    if (!tab) return;
    const item = tab.items.find((it) => it.productId === productId);
    if (!item) return;
    restockFor(item.recipe, item.qty);
    const items = tab.items.filter((it) => it.productId !== productId);
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? { ...t, items, updatedAt: Date.now() } : t)));
  };

  // The cross-out-as-prepared checklist, same idea as the Kitchen board's
  // toggleItemPrepared — checking off the last remaining item auto-completes
  // the whole tab (crossed out, moved to "Completed" — see TabsView), same
  // as a normal kitchen order, even though the tab is still unpaid.
  const toggleTabItemPrepared = (tabId, productId) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    if (!tab) return;
    const items = tab.items.map((it) => (it.productId === productId ? { ...it, prepared: !it.prepared } : it));
    const allPrepared = items.length > 0 && items.every((it) => it.prepared);
    const nextStatus = allPrepared ? "completed" : "preparing";
    const statusChanged = nextStatus !== (tab.status || "preparing");
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? {
      ...t,
      items,
      status: nextStatus,
      completedAt: nextStatus === "completed" ? Date.now() : null,
      updatedAt: Date.now(),
    } : t)));
    if (statusChanged && nextStatus === "completed") notify(`Tab "${tab.label}" completed.`);
  };

  // Manual override — mirrors the Kitchen board's setOrderStatus. Marking a
  // tab complete checks off every item too, so the checklist and the status
  // never disagree; reopening just flips the status back.
  const setTabStatus = (tabId, status) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    if (!tab) return;
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? {
      ...t,
      items: status === "completed" ? t.items.map((it) => ({ ...it, prepared: true })) : t.items,
      status,
      completedAt: status === "completed" ? Date.now() : null,
      updatedAt: Date.now(),
    } : t)));
    notify(status === "completed" ? `Tab "${tab.label}" completed.` : `Tab "${tab.label}" moved back to preparing.`);
  };

  const renameTab = (tabId, label) => {
    const trimmed = (label || "").trim();
    if (!trimmed) return;
    persistParkedOrders(parkedOrders.map((t) => (t.id === tabId ? { ...t, label: trimmed, updatedAt: Date.now() } : t)));
  };

  // Cancels a whole tab (customer changed their mind before paying anything)
  // — every item's ingredients go back to stock and the tab disappears.
  const cancelTab = (tabId) => {
    const tab = parkedOrders.find((t) => t.id === tabId);
    if (!tab) return;
    tab.items.forEach((it) => restockFor(it.recipe, it.qty));
    persistParkedOrders(parkedOrders.filter((t) => t.id !== tabId));
    if (settleTabTarget?.id === tabId) setSettleTabTarget(null);
    notify(`Tab "${tab.label}" cancelled — ingredients returned to stock.`);
  };

  // Turns a tab into a real, paid `sale` — this is the only point a tab
  // affects revenue/reports. Ingredients are NOT deducted again here; that
  // already happened as items were added to the tab (see deductStockFor
  // above). Whatever's already been crossed off as prepared carries over
  // onto the sale, so the Kitchen board / receipt reflect real progress
  // instead of resetting to "nothing prepared" just because payment
  // happened after the food did.
  const settleTab = (tab, payment) => {
    const { discountType, discountValue, discountAmount, paymentMethod, payments, amountTendered, paymentProof: proof } = payment;
    const subtotal = tab.items.reduce((s, it) => s + it.price * it.qty, 0);
    const total = Math.max(0, +(subtotal - discountAmount).toFixed(2));
    const totalCost = tab.items.reduce((s, it) => s + it.cost * it.qty, 0);
    const allPrepared = tab.items.length > 0 && tab.items.every((it) => it.prepared);
    const sale = {
      id: uid("sale"),
      orderNo: tab.orderNo,
      timestamp: tab.openedAt,
      paidAt: Date.now(),
      employeeId: currentEmployee?.id || tab.employeeId,
      employeeName: currentEmployee?.name || tab.employeeName,
      shiftId: activeShift?.id || tab.shiftId,
      status: allPrepared ? "completed" : "preparing",
      completedAt: allPrepared ? Date.now() : null,
      items: tab.items.map((it) => ({ ...it, voided: false })),
      subtotal,
      originalSubtotal: subtotal,
      originalDiscountAmount: discountAmount,
      originalTotal: total,
      originalTotalCost: totalCost,
      discountType,
      discountValue,
      discountAmount,
      total,
      totalCost,
      paymentMethod,
      payments,
      originalPayments: payments,
      amountTendered,
      change: paymentMethod === "cash" ? +(amountTendered - total).toFixed(2) : 0,
      paymentProof: (paymentMethod === "online" || paymentMethod === "split") ? proof : null,
      voided: false,
      voidReason: null,
      voidNote: "",
      voidedAt: null,
      // Kept for reference on the receipt/history detail — this was a tab,
      // not a straight-through checkout.
      tabLabel: tab.label,
    };
    persistSales([...sales, sale]);
    persistParkedOrders(parkedOrders.filter((t) => t.id !== tab.id));
    setSettleTabTarget(null);
    setReceipt(sale);
  };

  // ---------- Void / restore sale items ----------
  // Voiding works at the item level: each line item on a sale carries its own
  // `voided` flag. An order's own `voided` flag is DERIVED — true only once
  // every item on it is voided — so a sale can be "partially voided" (some
  // items active, some not) and Reports/CSV/receipts all reflect only the
  // active items' totals. Voiding an item returns its ingredients to stock
  // (via the recipe snapshot on that item); restoring deducts them again,
  // blocked per-item if there isn't enough stock to safely reverse.
  const recomputeSaleTotals = (sale) => {
    const activeItems = sale.items.filter((it) => !itemIsVoided(sale, it));
    const subtotal = +activeItems.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2);
    let discountAmount = 0;
    if (sale.discountType === "percent") {
      discountAmount = +Math.min(subtotal, (subtotal * (sale.discountValue || 0)) / 100).toFixed(2);
    } else if (sale.discountType === "amount") {
      // Scale the original flat discount down in proportion to how much of the
      // order is still active, so a voided item can't leave a stale discount
      // larger than what remains.
      const base = sale.originalSubtotal || sale.subtotal || 0;
      const ratio = base > 0 ? subtotal / base : 0;
      discountAmount = +Math.min(subtotal, (sale.originalDiscountAmount || 0) * ratio).toFixed(2);
    }
    const total = Math.max(0, +(subtotal - discountAmount).toFixed(2));
    const totalCost = +activeItems.reduce((s, it) => s + it.cost * it.qty, 0).toFixed(2);
    const allVoided = sale.items.length > 0 && sale.items.every((it) => itemIsVoided(sale, it));
    return { ...sale, subtotal, discountAmount, total, totalCost, voided: allVoided };
  };

  // voidIndices: items to void (no-op if already voided). restoreIndices: items
  // to restore (no-op if not currently voided; blocked individually if stock is
  // insufficient — other requested changes still go through).
  const applySaleItemChanges = (id, { voidIndices = [], restoreIndices = [], reason, note, approvedById, approvedByName }) => {
    const sale = sales.find((s) => s.id === id);
    if (!sale) return;

    if (restoreIndices.length > 0 && !approvedByName) {
      notify("Restoring requires manager approval.", "err");
      return;
    }

    const wantsRestore = new Set(restoreIndices.filter((idx) => itemIsVoided(sale, sale.items[idx])));
    const restoreNeeds = {};
    wantsRestore.forEach((idx) => {
      const it = sale.items[idx];
      (it.recipe || []).forEach((r) => { restoreNeeds[r.ingredientId] = (restoreNeeds[r.ingredientId] || 0) + r.amount * it.qty; });
    });
    const shortages = Object.entries(restoreNeeds)
      .map(([ingId, needed]) => {
        const ing = ingredientMap[ingId];
        if (!ing) return null;
        return needed > ing.stock ? { name: ing.name } : null;
      })
      .filter(Boolean);
    // If ANY restored item would overdraw a shared ingredient, block all
    // restores this round (simpler and safer than partially applying a set
    // whose combined need was the thing that failed) — voids still proceed.
    const blockRestores = shortages.length > 0;
    if (blockRestores) {
      notify(`Can't restore — not enough stock for ${shortages.map((s) => s.name).join(", ")}.`, "err");
    }

    const now = Date.now();
    const byId = currentEmployee?.id || null;
    const byName = currentEmployee?.name || "Unassigned";
    const stockDelta = {}; // +qty returned to stock, -qty taken back out

    const items = sale.items.map((it, idx) => {
      if (voidIndices.includes(idx) && !itemIsVoided(sale, it)) {
        (it.recipe || []).forEach((r) => { stockDelta[r.ingredientId] = (stockDelta[r.ingredientId] || 0) + r.amount * it.qty; });
        return { ...it, voided: true, voidReason: reason, voidNote: note || "", voidedAt: now, voidedById: byId, voidedByName: byName };
      }
      if (!blockRestores && wantsRestore.has(idx)) {
        (it.recipe || []).forEach((r) => { stockDelta[r.ingredientId] = (stockDelta[r.ingredientId] || 0) - r.amount * it.qty; });
        return { ...it, voided: false, restoredAt: now, restoredById: byId, restoredByName: byName };
      }
      return it;
    });

    const nextIngredients = catalog.ingredients.map((i) =>
      stockDelta[i.id] ? { ...i, stock: +(i.stock + stockDelta[i.id]).toFixed(2) } : i
    );

    let updated = recomputeSaleTotals({ ...sale, items });
    if (voidIndices.some((idx) => !itemIsVoided(sale, sale.items[idx]))) {
      updated = {
        ...updated,
        voidReason: reason,
        voidNote: note || "",
        voidedAt: now,
        voidedById: byId,
        voidedByName: byName,
        approvedById: approvedById || null,
        approvedByName: approvedByName || null,
      };
    }
    if (!blockRestores && wantsRestore.size > 0) {
      updated = {
        ...updated,
        restoredAt: now,
        restoredById: byId,
        restoredByName: byName,
        restoreApprovedById: approvedById || null,
        restoreApprovedByName: approvedByName || null,
      };
    }

    persistCatalog({ ...catalog, ingredients: nextIngredients });
    persistSales(sales.map((s) => (s.id === id ? updated : s)));

    if (updated.voided) notify("Order voided — ingredients returned to stock.");
    else if (voidIndices.length && wantsRestore.size) notify("Order updated — some items voided, some restored.");
    else if (voidIndices.length) notify("Item(s) voided — ingredients returned, order total updated.");
    else if (!blockRestores && wantsRestore.size) notify("Item(s) restored — ingredients deducted again.");
  };

  // Quick full-order actions used by the simple Void/Restore buttons in history.
  const voidWholeSale = (id, reason, note, approvedById, approvedByName) => {
    const sale = sales.find((s) => s.id === id);
    if (!sale) return;
    applySaleItemChanges(id, { voidIndices: sale.items.map((_, i) => i), reason, note, approvedById, approvedByName });
  };
  const restoreSale = (id, approvedById, approvedByName) => {
    const sale = sales.find((s) => s.id === id);
    if (!sale) return;
    applySaleItemChanges(id, { restoreIndices: sale.items.map((_, i) => i), approvedById, approvedByName });
  };

  // ---------- Kitchen board ----------
  // Toggling a line item is per-order-per-product (checkout already collapses
  // the cart to one line per product, so productId is a safe key within a
  // single sale). Checking off the last remaining active item auto-completes
  // the whole order — that's the common case — but a manual complete/reopen
  // is still available for overrides.
  const toggleItemPrepared = (saleId, productId) => {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return;
    const items = sale.items.map((it) =>
      it.productId === productId ? { ...it, prepared: !it.prepared } : it
    );
    const activeItems = items.filter((it) => !itemIsVoided(sale, it));
    const allPrepared = activeItems.length > 0 && activeItems.every((it) => it.prepared);
    const nextStatus = allPrepared ? "completed" : "preparing";
    const statusChanged = nextStatus !== (sale.status || "preparing");
    persistSales(sales.map((s) => (s.id === saleId ? {
      ...s,
      items,
      status: nextStatus,
      completedAt: nextStatus === "completed" ? Date.now() : null,
    } : s)));
    if (statusChanged && nextStatus === "completed") notify(`Order #${sale.orderNo} completed.`);
  };
  const setOrderStatus = (saleId, status) => {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return;
    persistSales(sales.map((s) => (s.id === saleId ? {
      ...s,
      // Marking complete manually checks off every still-active item too, so
      // the checklist and the status never disagree; reopening just flips the
      // status back and leaves whatever was checked as-is.
      items: status === "completed" ? s.items.map((it) => (itemIsVoided(s, it) ? it : { ...it, prepared: true })) : s.items,
      status,
      completedAt: status === "completed" ? Date.now() : null,
    } : s)));
    notify(status === "completed" ? `Order #${sale.orderNo} completed.` : `Order #${sale.orderNo} moved back to preparing.`);
  };

  // ---------- Reports ----------
  const filteredSales = useMemo(() => {
    const active = sales.filter((s) => !s.voided);
    if (reportMode === "day") return active.filter((s) => dateKey(s.timestamp) === reportDay);
    if (reportMode === "month") return active.filter((s) => monthKey(s.timestamp) === reportMonth);
    // range
    if (!reportRangeStart || !reportRangeEnd) return [];
    const lo = reportRangeStart <= reportRangeEnd ? reportRangeStart : reportRangeEnd;
    const hi = reportRangeStart <= reportRangeEnd ? reportRangeEnd : reportRangeStart;
    return active.filter((s) => {
      const k = dateKey(s.timestamp);
      return k >= lo && k <= hi;
    });
  }, [sales, reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  // Same period, but the voided sales — kept separate so Reports can show what
  // was lost to voids (cost/revenue/profit) without counting it in the totals above.
  const filteredVoidedSales = useMemo(() => {
    const voided = sales.filter((s) => s.voided);
    if (reportMode === "day") return voided.filter((s) => dateKey(s.timestamp) === reportDay);
    if (reportMode === "month") return voided.filter((s) => monthKey(s.timestamp) === reportMonth);
    if (!reportRangeStart || !reportRangeEnd) return [];
    const lo = reportRangeStart <= reportRangeEnd ? reportRangeStart : reportRangeEnd;
    const hi = reportRangeStart <= reportRangeEnd ? reportRangeEnd : reportRangeStart;
    return voided.filter((s) => {
      const k = dateKey(s.timestamp);
      return k >= lo && k <= hi;
    });
  }, [sales, reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  // Waste/spoilage logged during the same reporting period — kept out of
  // revenue/cost/profit (nothing was sold) but surfaced so the numbers don't
  // quietly drift from what's actually happening to stock.
  const filteredWaste = useMemo(() => {
    if (reportMode === "day") return wasteLogs.filter((w) => dateKey(w.timestamp) === reportDay);
    if (reportMode === "month") return wasteLogs.filter((w) => monthKey(w.timestamp) === reportMonth);
    if (!reportRangeStart || !reportRangeEnd) return [];
    const lo = reportRangeStart <= reportRangeEnd ? reportRangeStart : reportRangeEnd;
    const hi = reportRangeStart <= reportRangeEnd ? reportRangeEnd : reportRangeStart;
    return wasteLogs.filter((w) => {
      const k = dateKey(w.timestamp);
      return k >= lo && k <= hi;
    });
  }, [wasteLogs, reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  const reportStats = useMemo(() => {
    const revenue = filteredSales.reduce((s, x) => s + x.total, 0);
    const cost = filteredSales.reduce((s, x) => s + x.totalCost, 0);
    const itemsSold = filteredSales.reduce(
      (s, x) => s + x.items.filter((i) => !itemIsVoided(x, i)).reduce((a, i) => a + i.qty, 0),
      0
    );
    const discountsGiven = filteredSales.reduce((s, x) => s + (x.discountAmount || 0), 0);
    const cashRevenue = filteredSales.reduce((s, x) => s + saleCashAmount(x), 0);
    const onlineRevenue = filteredSales.reduce((s, x) => s + saleOnlineAmount(x), 0);
    const bestMap = {};
    filteredSales.forEach((s) => s.items.filter((i) => !itemIsVoided(s, i)).forEach((i) => {
      bestMap[i.name] = bestMap[i.name] || { name: i.name, qty: 0, revenue: 0 };
      bestMap[i.name].qty += i.qty;
      bestMap[i.name].revenue += i.price * i.qty;
    }));
    const best = Object.values(bestMap).sort((a, b) => b.qty - a.qty).slice(0, 6);
    const empMap = {};
    filteredSales.forEach((s) => {
      const key = s.employeeName || "Unassigned";
      empMap[key] = empMap[key] || { name: key, orders: 0, revenue: 0 };
      empMap[key].orders += 1;
      empMap[key].revenue += s.total;
    });
    const byEmployee = Object.values(empMap).sort((a, b) => b.revenue - a.revenue);
    // What voiding cost this period, purely for audit visibility — never mixed
    // into revenue/cost/profit above. Use each voided sale's ORIGINAL amounts,
    // since its live total/totalCost are recomputed down to 0 once every item
    // is voided (correct for reports, but not what was actually forgone).
    const voidedRevenue = filteredVoidedSales.reduce((s, x) => s + (x.originalTotal ?? x.total), 0);
    const voidedCost = filteredVoidedSales.reduce((s, x) => s + (x.originalTotalCost ?? x.totalCost), 0);
    const voidedProfit = voidedRevenue - voidedCost;
    const wasteCost = filteredWaste.reduce((s, w) => s + w.cost, 0);
    const wasteByReason = WASTE_REASONS.map((r) => ({
      reason: r,
      cost: filteredWaste.filter((w) => w.reason === r).reduce((s, w) => s + w.cost, 0),
    })).filter((r) => r.cost > 0);
    return {
      revenue, cost, profit: revenue - cost, orders: filteredSales.length, itemsSold, best,
      discountsGiven, cashRevenue, onlineRevenue, byEmployee,
      voidedOrders: filteredVoidedSales.length, voidedRevenue, voidedCost, voidedProfit,
      wasteCost, wasteEntries: filteredWaste.length, wasteByReason,
    };
  }, [filteredSales, filteredVoidedSales, filteredWaste]);

  const trendData = useMemo(() => {
    const active = sales.filter((s) => !s.voided);
    if (reportMode === "day") {
      const days = [...Array(7)].map((_, idx) => {
        const d = new Date(); d.setDate(d.getDate() - (6 - idx));
        return dateKey(d.getTime());
      });
      return days.map((k) => ({
        key: k,
        label: fmtDay(k),
        revenue: active.filter((s) => dateKey(s.timestamp) === k).reduce((a, s) => a + s.total, 0),
      }));
    }
    if (reportMode === "month") {
      const months = [...Array(6)].map((_, idx) => {
        const d = new Date(); d.setMonth(d.getMonth() - (5 - idx));
        return monthKey(d.getTime());
      });
      return months.map((k) => ({
        key: k,
        label: fmtMonth(k),
        revenue: active.filter((s) => monthKey(s.timestamp) === k).reduce((a, s) => a + s.total, 0),
      }));
    }
    // range — build one bar per day in the range (or per month if the range is long)
    if (!reportRangeStart || !reportRangeEnd) return [];
    const lo = reportRangeStart <= reportRangeEnd ? reportRangeStart : reportRangeEnd;
    const hi = reportRangeStart <= reportRangeEnd ? reportRangeEnd : reportRangeStart;
    const loDate = new Date(lo + "T00:00:00");
    const hiDate = new Date(hi + "T00:00:00");
    const spanDays = Math.round((hiDate - loDate) / 86400000) + 1;
    if (spanDays <= 62) {
      const out = [];
      for (let i = 0; i < spanDays; i++) {
        const d = new Date(loDate); d.setDate(d.getDate() + i);
        const k = dateKey(d.getTime());
        out.push({ key: k, label: fmtDay(k), revenue: active.filter((s) => dateKey(s.timestamp) === k).reduce((a, s) => a + s.total, 0) });
      }
      return out;
    }
    // long range: aggregate by month
    const monthsSet = [];
    const cursor = new Date(loDate.getFullYear(), loDate.getMonth(), 1);
    const endCursor = new Date(hiDate.getFullYear(), hiDate.getMonth(), 1);
    while (cursor <= endCursor) {
      monthsSet.push(monthKey(cursor.getTime()));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return monthsSet.map((k) => ({
      key: k,
      label: fmtMonth(k),
      revenue: active.filter((s) => monthKey(s.timestamp) === k).reduce((a, s) => a + s.total, 0),
    }));
  }, [sales, reportMode, reportRangeStart, reportRangeEnd]);

  const reportPeriodLabel = useMemo(() => {
    if (reportMode === "day") return new Date(reportDay + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    if (reportMode === "month") return fmtMonth(reportMonth);
    if (!reportRangeStart || !reportRangeEnd) return "";
    const lo = reportRangeStart <= reportRangeEnd ? reportRangeStart : reportRangeEnd;
    const hi = reportRangeStart <= reportRangeEnd ? reportRangeEnd : reportRangeStart;
    return `${fmtDay(lo)} – ${fmtDay(hi)}`;
  }, [reportMode, reportDay, reportMonth, reportRangeStart, reportRangeEnd]);

  // ---------- Sales history (separate date filter from Reports, shows voided sales too) ----------
  const historySales = useMemo(() => {
    const byDate = (s) => {
      if (historyMode === "day") return dateKey(s.timestamp) === historyDay;
      if (!historyRangeStart || !historyRangeEnd) return false;
      const lo = historyRangeStart <= historyRangeEnd ? historyRangeStart : historyRangeEnd;
      const hi = historyRangeStart <= historyRangeEnd ? historyRangeEnd : historyRangeStart;
      const k = dateKey(s.timestamp);
      return k >= lo && k <= hi;
    };
    return sales.filter(byDate).slice().sort((a, b) => b.timestamp - a.timestamp);
  }, [sales, historyMode, historyDay, historyRangeStart, historyRangeEnd]);

  const historyStats = useMemo(() => {
    const active = historySales.filter((s) => !s.voided);
    const voided = historySales.filter((s) => s.voided);
    return {
      activeCount: active.length,
      activeRevenue: active.reduce((s, x) => s + x.total, 0),
      voidedCount: voided.length,
      // Fully-voided sales recompute to $0 (nothing active left) — show what
      // was originally charged instead, for an accurate "voided amount" figure.
      voidedRevenue: voided.reduce((s, x) => s + (x.originalTotal ?? x.total), 0),
    };
  }, [historySales]);

  // ---------- Kitchen board lists ----------
  // Preparing: oldest first, so the board reads first-in-first-out like a
  // ticket rail. Completed: today only (older completions are still in Sales
  // history/Reports — the board just doesn't need to carry them around) and
  // newest first, so a just-finished order is easy to find/undo.
  const kitchenPreparing = useMemo(
    () => sales.filter((s) => !s.voided && s.status === "preparing").slice().sort((a, b) => a.timestamp - b.timestamp),
    [sales]
  );
  const kitchenCompletedToday = useMemo(
    () => sales
      .filter((s) => !s.voided && s.status === "completed" && dateKey(s.completedAt || s.timestamp) === todayKey())
      .slice()
      .sort((a, b) => (b.completedAt || b.timestamp) - (a.completedAt || a.timestamp)),
    [sales]
  );

  const resetAll = async () => {
    const cat = seedCatalog();
    await safeSet(CATALOG_KEY, cat);
    await safeSet(SALES_KEY, []);
    await safeSet(SHIFTS_KEY, []);
    await safeSet(WASTE_KEY, []);
    setCatalog(cat);
    setSales([]);
    setShifts([]);
    setWasteLogs([]);
    setCart([]);
    setConfirmReset(false);
    notify("Data reset to sample catalog.");
  };

  const filteredProducts = catalog.products.filter((p) => posFilter === "all" || p.category === posFilter);

  if (!authChecked) {
    return (
      <Shell>
        <div className="flex items-center justify-center h-96" style={{ color: "var(--ink-soft)" }}>
          Loading…
        </div>
      </Shell>
    );
  }

  if (passwordRecovery) {
    return (
      <Shell>
        <ResetPasswordView onConfirm={completePasswordRecovery} onCancel={cancelPasswordRecovery} />
      </Shell>
    );
  }

  if (!loggedIn) {
    return (
      <Shell>
        {authMode === "login" ? (
          <LoginView account={account} onLogIn={logIn} onResetPassword={requestPasswordReset} onSwitchToSignUp={() => setAuthMode("signup")} />
        ) : (
          <SignUpView onSignUp={signUp} onSwitchToLogin={() => setAuthMode("login")} />
        )}
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center h-96" style={{ color: "var(--ink-soft)" }}>
          Loading the counter…
        </div>
      </Shell>
    );
  }

  // Safety net: every normal sign-up already saves a business name straight
  // into `businesses.business_name` (see signUp()), so this should never
  // actually fire for an account created the normal way. It exists purely
  // to catch accounts that ended up with a blank name some other way (an
  // older row from before this existed, a row inserted by hand, etc.) —
  // instead of silently showing a blank name forever, the app stops here
  // exactly once and asks for it, then never asks again. There's no way to
  // dismiss this without entering something, and it takes priority over the
  // trial/upgrade screen below so the name is always in place first.
  if (!account?.businessName || !account.businessName.trim()) {
    return (
      <Shell>
        <CompleteProfileView
          account={account}
          onSave={(name) => updateAccountField("businessName", name)}
          onLogOut={logOut}
        />
      </Shell>
    );
  }

  // Trial expired and never upgraded: block the whole app behind the
  // upgrade screen. There's no dismiss button here (onClose is null) —
  // the owner has to either pay via PayMongo (PH) or PayPal (everywhere
  // else) and self-report it, or log out.
  if (trialInfo.expired && !trialInfo.isSubscribed) {
    return (
      <Shell>
        <Header
          businessName={account?.businessName}
          low={0}
          confirmReset={false}
          setConfirmReset={() => {}}
          resetAll={() => {}}
          currencyCode={currencyCode}
          changeCurrency={() => {}}
          employees={[]}
          currentEmployee={null}
          selectEmployee={() => {}}
          openEmployeeModal={() => {}}
        />
        <UpgradeView
          account={account}
          trialInfo={trialInfo}
          currencyCode={currencyCode}
          onConfirm={markSubscriptionActive}
          onApplyCode={applyReferralCode}
          onClose={null}
          onLogOut={logOut}
          onRefreshAccount={refreshAccountStatus}
        />
        {updateWaitingToApply && <UpdateBanner onRefreshNow={() => window.location.reload()} />}
      </Shell>
    );
  }

  return (
    <Shell>
      <Header
        businessName={account?.businessName}
        low={lowStock.length}
        confirmReset={confirmReset}
        setConfirmReset={setConfirmReset}
        resetAll={resetAll}
        currencyCode={currencyCode}
        changeCurrency={changeCurrency}
        employees={employees}
        currentEmployee={currentEmployee}
        selectEmployee={requestEmployeeChange}
        openEmployeeModal={() => setEmployeeModal(true)}
      />
      <Nav view={view} setView={setView} lowCount={lowStock.length} shiftOpen={!!activeShift} kitchenCount={kitchenPreparing.length} tabsCount={parkedOrders.length} />

      {!trialInfo.isSubscribed && !trialInfo.expired && (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 no-print">
          <div
            className="mt-2 flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg"
            style={{ background: "#FBF1E7", color: "var(--ink-soft)" }}
          >
            <span>
              {trialInfo.daysLeft} day{trialInfo.daysLeft === 1 ? "" : "s"} left in your free trial.
            </span>
            <button
              onClick={() => setShowUpgrade(true)}
              className="px-2.5 py-1 rounded-full font-medium"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Upgrade
            </button>
          </div>
        </div>
      )}

      <main className="px-4 sm:px-6 pb-16 pt-4 max-w-6xl mx-auto">
        {view === "pos" && (
          activeShift ? (
          <POSView
            products={filteredProducts}
            categories={catalog.categories}
            ingredients={catalog.ingredients}
            posFilter={posFilter}
            setPosFilter={setPosFilter}
            addToCart={addToCart}
            cartDetailed={cartDetailed}
            changeQty={changeQty}
            removeFromCart={removeFromCart}
            clearCart={clearCart}
            subtotal={subtotal}
            discountType={discountType}
            setDiscountType={setDiscountType}
            discountValue={discountValue}
            setDiscountValue={setDiscountValue}
            discountAmount={discountAmount}
            cartTotal={cartTotal}
            paymentMethod={paymentMethod}
            setPaymentMethod={setPaymentMethod}
            cashReceived={cashReceived}
            setCashReceived={setCashReceived}
            changeDue={changeDue}
            splitPayments={splitPayments}
            splitPaymentsResolved={splitPaymentsResolved}
            splitMode={splitMode}
            setSplitMode={setSplitMode}
            splitItemLegs={splitItemLegs}
            assignSplitItem={assignSplitItem}
            addSplitLine={addSplitLine}
            removeSplitLine={removeSplitLine}
            updateSplitMethod={updateSplitMethod}
            updateSplitAmount={updateSplitAmount}
            checkout={checkout}
            checkoutError={checkoutError}
            paymentProof={paymentProof}
            setPaymentProof={setPaymentProof}
            proofProcessing={proofProcessing}
            uploadPaymentProof={uploadPaymentProof}
            nextOrderNo={nextOrderNo}
            openParkModal={() => setParkModalOpen(true)}
          />
          ) : (
            <NoShiftGate onGoToShift={() => setView("shift")} />
          )
        )}
        {view === "tabs" && (
          <TabsView
            tabs={parkedOrders}
            products={catalog.products}
            categories={catalog.categories}
            onRename={renameTab}
            onAddItem={addItemToTab}
            onIncrement={addItemToTab}
            onDecrement={decrementTabItem}
            onRemoveItem={removeTabItem}
            onTogglePrepared={toggleTabItemPrepared}
            onSetStatus={setTabStatus}
            onCancelTab={cancelTab}
            onSettle={(tab) => setSettleTabTarget(tab)}
          />
        )}
        {view === "kitchen" && (
          <KitchenView
            preparing={kitchenPreparing}
            completed={kitchenCompletedToday}
            toggleItemPrepared={toggleItemPrepared}
            setOrderStatus={setOrderStatus}
          />
        )}
        {view === "products" && (
          <ProductsView
            products={catalog.products}
            ingredients={catalog.ingredients}
            categories={catalog.categories}
            productCost={productCost}
            openNew={() => setProdModal({})}
            openEdit={(p) => setProdModal(p)}
            deleteProduct={deleteProduct}
            openCategories={() => setCatModal(true)}
          />
        )}
        {view === "inventory" && (
          <InventoryView
            ingredients={catalog.ingredients}
            products={catalog.products}
            openNew={() => setIngModal({})}
            openEdit={(i) => setIngModal(i)}
            deleteIngredient={deleteIngredient}
            restockId={restockId}
            setRestockId={setRestockId}
            restockVal={restockVal}
            setRestockVal={setRestockVal}
            applyRestock={applyRestock}
            wasteLogs={wasteLogs}
            openWasteModal={() => setWasteModal(true)}
          />
        )}
        {view === "shift" && (
          <ShiftView
            activeShift={activeShift}
            shifts={shifts}
            currentEmployee={currentEmployee}
            cashSoFar={shiftCashSoFar(activeShift)}
            onlineSoFar={shiftOnlineSoFar(activeShift)}
            openShift={openShift}
            openCloseModal={() => setShiftCloseModal(true)}
          />
        )}
        {view === "history" && (
          <SalesHistoryView
            historyMode={historyMode}
            setHistoryMode={setHistoryMode}
            historyDay={historyDay}
            setHistoryDay={setHistoryDay}
            historyRangeStart={historyRangeStart}
            setHistoryRangeStart={setHistoryRangeStart}
            historyRangeEnd={historyRangeEnd}
            setHistoryRangeEnd={setHistoryRangeEnd}
            sales={historySales}
            stats={historyStats}
            openVoid={(sale) => setVoidModal(sale)}
            openRestore={(sale) => setRestoreModal(sale)}
            detailSale={detailSale}
            setDetailSale={setDetailSale}
          />
        )}
        {view === "reports" && (
          <ReportsView
            reportMode={reportMode}
            setReportMode={setReportMode}
            reportDay={reportDay}
            setReportDay={setReportDay}
            reportMonth={reportMonth}
            setReportMonth={setReportMonth}
            reportRangeStart={reportRangeStart}
            setReportRangeStart={setReportRangeStart}
            reportRangeEnd={reportRangeEnd}
            setReportRangeEnd={setReportRangeEnd}
            stats={reportStats}
            trendData={trendData}
            lowStock={lowStock}
            sales={filteredSales}
            voidedSales={filteredVoidedSales}
            periodLabel={reportPeriodLabel}
            detailSale={detailSale}
            setDetailSale={setDetailSale}
          />
        )}
        {view === "settings" && (
          <SettingsView
            account={account}
            onUpdateField={updateAccountField}
            onLogOut={logOut}
            onDeleteAccount={deleteAccount}
            onUnsubscribe={unsubscribeAccount}
            trialInfo={trialInfo}
            currencyCode={currencyCode}
            openUpgrade={() => setShowUpgrade(true)}
          />
        )}
      </main>

      {showUpgrade && (
        <UpgradeView
          account={account}
          trialInfo={trialInfo}
          currencyCode={currencyCode}
          onConfirm={markSubscriptionActive}
          onApplyCode={applyReferralCode}
          onClose={trialInfo.expired && !trialInfo.isSubscribed ? null : () => setShowUpgrade(false)}
          onRefreshAccount={refreshAccountStatus}
          notify={notify}
        />
      )}

      {ingModal !== null && (
        <IngredientModal
          initial={ingModal}
          onClose={() => setIngModal(null)}
          onSave={saveIngredient}
        />
      )}
      {prodModal !== null && (
        <ProductModal
          initial={prodModal}
          ingredients={catalog.ingredients}
          categories={catalog.categories}
          onClose={() => setProdModal(null)}
          onSave={saveProduct}
        />
      )}
      {catModal && (
        <CategoryModal
          categories={catalog.categories}
          onClose={() => setCatModal(false)}
          onAdd={addCategory}
          onDelete={deleteCategory}
        />
      )}
      {employeeModal && (
        <EmployeeModal
          employees={employees}
          currentEmployeeId={currentEmployeeId}
          onClose={() => setEmployeeModal(false)}
          onAdd={addEmployee}
          onDelete={removeEmployee}
          onSelect={requestEmployeeChange}
          onUpdatePin={updateEmployeePin}
        />
      )}
      {wasteModal && (
        <WasteModal
          ingredients={catalog.ingredients}
          products={catalog.products}
          onClose={() => setWasteModal(false)}
          onSaveIngredient={logWaste}
          onSaveProduct={logProductWaste}
        />
      )}
      {shiftCloseModal && activeShift && (
        <ShiftCloseModal
          shift={activeShift}
          expectedCash={+(activeShift.openingFloat + shiftCashSoFar(activeShift)).toFixed(2)}
          cashCollected={shiftCashSoFar(activeShift)}
          onlineCollected={shiftOnlineSoFar(activeShift)}
          currentEmployee={currentEmployee}
          onClose={() => setShiftCloseModal(false)}
          onConfirm={closeShift}
        />
      )}
      {pendingEmployee && activeShift && (
        <EmployeeHandoffModal
          shift={activeShift}
          expectedCash={+(activeShift.openingFloat + shiftCashSoFar(activeShift)).toFixed(2)}
          cashCollected={shiftCashSoFar(activeShift)}
          onlineCollected={shiftOnlineSoFar(activeShift)}
          outgoingEmployee={currentEmployee}
          incomingEmployee={pendingEmployee}
          onClose={() => setPendingEmployeeSwitch(null)}
          onConfirm={confirmHandoff}
        />
      )}
      {receipt && <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} />}
      {detailSale && <ReceiptModal sale={detailSale} onClose={() => setDetailSale(null)} closeLabel="Close" />}
      {parkModalOpen && (
        <ParkOrderModal
          nextOrderNo={nextOrderNo}
          onClose={() => setParkModalOpen(false)}
          onConfirm={parkOrder}
        />
      )}
      {settleTabTarget && (
        <SettleTabModal
          tab={settleTabTarget}
          onClose={() => setSettleTabTarget(null)}
          onConfirm={(payment) => settleTab(settleTabTarget, payment)}
        />
      )}
      {voidModal && (
        <VoidSaleModal
          sale={voidModal}
          approverOptions={approverOptions}
          onClose={() => setVoidModal(null)}
          onConfirm={(voidIndices, restoreIndices, reason, note, approvedById, approvedByName) => {
            applySaleItemChanges(voidModal.id, { voidIndices, restoreIndices, reason, note, approvedById, approvedByName });
            setVoidModal(null);
          }}
        />
      )}
      {restoreModal && (
        <RestoreSaleModal
          sale={restoreModal}
          approverOptions={approverOptions}
          onClose={() => setRestoreModal(null)}
          onConfirm={(approvedById, approvedByName) => {
            restoreSale(restoreModal.id, approvedById, approvedByName);
            setRestoreModal(null);
          }}
        />
      )}
      {toast && <Toast toast={toast} />}
      {updateWaitingToApply && <UpdateBanner onRefreshNow={() => window.location.reload()} />}
    </Shell>
  );
}

// ============== Shell / layout bits ==============

function Shell({ children }) {
  return (
    <div
      className="min-h-screen"
      style={{
        "--bg": "#F5F1E6",
        "--surface": "#FFFFFF",
        "--ink": "#2B2420",
        "--ink-soft": "#7A6D5C",
        "--primary": "#4F5E33",
        "--primary-dark": "#39441F",
        "--accent": "#C99A2E",
        "--alert": "#B5442E",
        "--line": "#E4DCC8",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "'IBM Plex Sans', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .display-font { font-family: 'Fraunces', serif; }
        .mono-font { font-family: 'IBM Plex Mono', monospace; }
        .ticket-edge-top {
          height: 14px;
          background-image: radial-gradient(circle at 7px 0, transparent 7px, var(--surface) 7.3px);
          background-size: 14px 14px;
          background-repeat: repeat-x;
        }
        .ticket-edge-bottom {
          height: 14px;
          background-image: radial-gradient(circle at 7px 14px, transparent 7px, var(--surface) 7.3px);
          background-size: 14px 14px;
          background-repeat: repeat-x;
        }
        .scrollbar-thin::-webkit-scrollbar { width: 7px; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
        input, select { outline: none; }
        input:focus, select:focus, button:focus-visible {
          box-shadow: 0 0 0 2px var(--primary);
          border-radius: 6px;
        }
        .print-only { display: none; }
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body, .min-h-screen { background: #fff !important; }
        }
      `}</style>
      {children}
    </div>
  );
}

// =============================================================================
// INSTALL APP (cross-device "add to home screen" / PWA install)
// =============================================================================
// Works three different ways depending on the device, because there's no
// single API every browser supports:
//   - Chrome / Edge / most Android browsers fire a `beforeinstallprompt`
//     event we can hook into and trigger programmatically — the button just
//     calls deferredPrompt.prompt().
//   - iOS Safari never fires that event (Apple doesn't support it), so on
//     iOS we detect that and show a small "tap Share, then Add to Home
//     Screen" instruction modal instead.
//   - Everywhere else (older/unsupported browsers, or once already
//     installed) the button either shows generic instructions or hides
//     itself entirely (see isStandalone below).
// This only works at all once the app is served over https with a
// manifest.json linked from index.html — see the deployment notes at the
// end of this file / the separate manifest.json and sw.js this comes with.
//
// TIMING NOTE: the browser can fire `beforeinstallprompt` within the first
// instant the page loads — sometimes before this component has even
// mounted. If we only listened for it here, that first event could be
// missed on a fast load, and the button would fall back to manual
// instructions even on a browser that fully supports one-tap install. To
// avoid that, index.html has a tiny inline script that starts listening
// immediately (before any app code loads) and stashes the event on
// `window.__deferredInstallPrompt`. We just check for that here in
// addition to listening for the live event ourselves.
// Detects when the page is running inside another app's built-in ("in-app")
// browser rather than a real, full browser — e.g. someone tapped the link
// inside Messenger, Instagram, Facebook, TikTok, Line, or WeChat. This
// matters a lot here: inside these webviews `beforeinstallprompt` never
// fires AND there is no browser menu with "Add to Home Screen" to find —
// the feature is not hidden, it's genuinely absent. No amount of on-page
// code can install a PWA from inside one of these; the only fix is for the
// person to leave the host app and open the link in their real browser
// (Chrome, Safari, Edge, Firefox...). Returns a human-readable app name for
// the message, or null if this looks like a normal browser.
function detectInAppBrowser(ua) {
  const knownHosts = [
    { name: "Facebook", re: /FBAN|FBAV|FB_IAB/i },
    { name: "Instagram", re: /Instagram/i },
    { name: "TikTok", re: /musical_ly|BytedanceWebview|TikTok/i },
    { name: "Line", re: /\bLine\//i },
    { name: "WeChat", re: /MicroMessenger/i },
    { name: "Twitter/X", re: /Twitter/i },
    { name: "LinkedIn", re: /LinkedInApp/i },
    { name: "Snapchat", re: /Snapchat/i },
    { name: "Pinterest", re: /Pinterest/i },
    { name: "WhatsApp", re: /\bWhatsApp\//i },
  ];
  for (const host of knownHosts) if (host.re.test(ua)) return host.name;
  // Generic Android WebView fingerprint (a bare "; wv)" token in the UA) —
  // catches other apps' in-app browsers that don't self-identify above.
  if (/Android/i.test(ua) && /\bwv\)/i.test(ua)) return "this app's";
  // Generic iOS in-app browser fingerprint: standalone WebKit content
  // views typically drop "Safari" from the UA string even though they're
  // still WebKit-based, unlike real Mobile Safari.
  if (/iphone|ipad|ipod/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari/i.test(ua)) return "this app's";
  return null;
}

function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isIOSNonSafari, setIsIOSNonSafari] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);
  const [inAppBrowser, setInAppBrowser] = useState(null);
  // iPad (real UA token, or the "Mac in disguise" case below) shows its
  // Share icon up in the toolbar next to the address bar, not at the bottom
  // like iPhone — so install instructions need to point somewhere different.
  const [isIPad, setIsIPad] = useState(false);
  // Genuine desktop Safari on a Mac (no touchscreen, so not an iPad wearing
  // a Mac costume, and not Chrome/Edge/Firefox on Mac either) — its Share
  // icon lives at the top right of the window, right by the address bar.
  const [isDesktopSafari, setIsDesktopSafari] = useState(false);

  useEffect(() => {
    const standalone =
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true; // iOS Safari's own flag
    setIsStandalone(!!standalone);

    const ua = window.navigator.userAgent || "";
    // iPadOS (13+) ships a desktop-style UA by default — it identifies as
    // "Macintosh" with no "iPad" token at all unless the person has manually
    // turned off "Request Desktop Website". The old regex-only check missed
    // every iPad because of this. The standard workaround: a "Mac" that also
    // reports multi-touch support is actually an iPad wearing a Mac costume.
    const iPadDesktopMode =
      navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const iosDevice = (/iphone|ipad|ipod/i.test(ua) && !window.MSStream) || iPadDesktopMode;
    setIsIOS(iosDevice);
    // Either a real iPad UA, or the "Mac in disguise" iPad detected above —
    // either way its Share icon sits in the top toolbar, not the bottom.
    setIsIPad(/ipad/i.test(ua) || iPadDesktopMode);
    // A real Mac desktop, running actual Safari (not Chrome/Firefox/Edge on
    // Mac, and not an iPad reporting itself as "Macintosh" — that case is
    // excluded via the touch-point check, same as iPadDesktopMode above).
    const macDesktop = navigator.platform === "MacIntel" && !(navigator.maxTouchPoints > 1);
    const macSafari = macDesktop && /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|OPR|Firefox/i.test(ua);
    setIsDesktopSafari(macSafari);
    // On iOS, Apple requires every browser to use Safari's underlying engine,
    // but only Safari itself is allowed to expose "Add to Home Screen" / PWA
    // install. Chrome, Firefox, Edge, etc. on iOS are all Safari in a
    // different skin and CANNOT install a PWA no matter what menu you look
    // in — the person has to actually switch to Safari first. These UA
    // tokens are how each of those browsers self-identifies on iOS.
    setIsIOSNonSafari(iosDevice && /CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua));
    setIsAndroid(/Android/i.test(ua));
    setInAppBrowser(detectInAppBrowser(ua));

    // Was it already captured before this component mounted?
    if (window.__deferredInstallPrompt) {
      setDeferredPrompt(window.__deferredInstallPrompt);
    }

    const onBeforeInstall = (e) => {
      e.preventDefault(); // stop the browser's default mini-infobar
      window.__deferredInstallPrompt = e;
      setDeferredPrompt(e); // save it so our own button can trigger it later
    };
    const onInstalled = () => {
      window.__deferredInstallPrompt = null;
      setDeferredPrompt(null);
      setIsStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return null;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    window.__deferredInstallPrompt = null;
    setDeferredPrompt(null);
    return choice.outcome; // "accepted" | "dismissed"
  }, [deferredPrompt]);

  return {
    canPrompt: !!deferredPrompt, promptInstall, isStandalone, isIOS, isIOSNonSafari, isAndroid,
    inAppBrowser, isIPad, isDesktopSafari,
  };
}

function InstallAppButton({ size = "normal" }) {
  const {
    canPrompt, promptInstall, isStandalone, isIOS, isIOSNonSafari, isAndroid, inAppBrowser,
    isIPad, isDesktopSafari,
  } = useInstallPrompt();
  const [showHelp, setShowHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  // Already installed and running as an app — nothing to offer.
  if (isStandalone) return null;

  const handleClick = async () => {
    // Inside an in-app browser, `beforeinstallprompt` never fires (canPrompt
    // is always false there), so this branch is really just for real
    // browsers with native one-tap install support.
    if (canPrompt && !inAppBrowser) {
      await promptInstall();
    } else {
      setShowHelp(true);
    }
  };

  const pageUrl = typeof window !== "undefined" ? window.location.href : "";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API can itself be blocked inside some in-app webviews —
      // the link is still visible/selectable in the modal as a fallback.
    }
  };

  // Android-only escape hatch: this special "intent://" link asks the OS
  // to open the page in Chrome specifically, which is usually enough to
  // jump straight out of an in-app webview (Messenger, Instagram, etc.)
  // without the person having to hunt for a hidden menu first. It's simply
  // ignored on non-Android devices, so it's safe to always build.
  let androidChromeIntentUrl = null;
  try {
    const u = new URL(pageUrl);
    androidChromeIntentUrl = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end;`;
  } catch {
    androidChromeIntentUrl = null;
  }

  const small = size === "small";

  return (
    <>
      <button
        onClick={handleClick}
        className={`flex items-center gap-1.5 rounded-full font-medium no-print ${small ? "text-[11px] px-2 py-1" : "text-xs px-2.5 py-1.5"}`}
        style={{ background: "var(--primary)", color: "#fff" }}
        title="Install this app on your device"
      >
        <Download size={small ? 11 : 12} /> Install app
      </button>
      {showHelp && (
        <ModalWrap onClose={() => setShowHelp(false)}>
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Smartphone size={16} /> Install this app
            </div>

            {inAppBrowser ? (
              <>
                {/* There is no "Add to Home Screen" menu item to find here —
                    in-app webviews genuinely don't have one. The only real
                    fix is leaving the host app for a real browser. */}
                <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  You're viewing this inside {inAppBrowser} browser, which can't
                  install apps. Open this page in your regular browser (Chrome,
                  Safari, Edge…) instead — the <b>Install app</b> button will work
                  from there.
                </p>
                {isAndroid && androidChromeIntentUrl && (
                  <a
                    href={androidChromeIntentUrl}
                    className="block text-center text-xs px-3 py-2 rounded-lg font-medium"
                    style={{ background: "var(--primary)", color: "#fff" }}
                  >
                    Open in Chrome
                  </a>
                )}
                <button
                  onClick={copyLink}
                  className="w-full text-xs px-3 py-2 rounded-lg border font-medium"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                >
                  {copied ? "Link copied!" : "Copy this page's link"}
                </button>
                <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  <b>iPhone:</b> tap the <b>•••</b> or <b>Share</b> icon (usually at the
                  bottom of the screen) and choose <b>Open in Safari</b>.{" "}
                  <b>Android:</b> tap the same icon and choose <b>Open in Chrome</b>,
                  or paste the copied link into Chrome.
                </p>
              </>
            ) : isIOSNonSafari ? (
              <>
                {/* Apple only allows Safari itself to install a PWA — Chrome,
                    Firefox, and Edge on iOS all run on Safari's engine but
                    have no "Add to Home Screen" capability at all, in any
                    menu. The only fix is switching to actual Safari. */}
                <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  On iPhone/iPad, only <b>Safari</b> can install this app — Chrome,
                  Firefox, and Edge on iOS aren't allowed to, even though the
                  button looks the same. Open this page in Safari instead, then
                  tap <b>Install app</b> again.
                </p>
                <button
                  onClick={copyLink}
                  className="w-full text-xs px-3 py-2 rounded-lg border font-medium"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                >
                  {copied ? "Link copied!" : "Copy this page's link"}
                </button>
                <p className="text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  In Safari: paste the link (or find this page in your Safari
                  history/bookmarks), then tap the <b>Share</b> icon (the square
                  with an arrow —{" "}
                  {isIPad
                    ? "top right of the screen, near the address bar"
                    : "usually at the bottom of the screen"}
                  ) and choose <b>Add to Home Screen</b>.
                </p>
              </>
            ) : isDesktopSafari ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                In Safari, click the <b>Share</b> icon (the square with an arrow,
                at the top right near the address bar), then choose{" "}
                <b>Add to Dock</b> (or <b>Add to Home Screen</b> on older versions
                of Safari). The app icon will then open like any other app on
                your Mac.
              </p>
            ) : isIOS ? (
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                In Safari, tap the <b>Share</b> icon (the square with an arrow —{" "}
                {isIPad
                  ? "top right of the screen, near the address bar"
                  : "usually at the bottom of the screen"}
                ), then scroll down and tap <b>Add to Home Screen</b>. The app icon
                will appear on your home screen like any other app.
              </p>
            ) : (
              <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                Open this page's browser menu (usually the ⋮ or ••• icon) and look
                for <b>Install app</b> or <b>Add to Home Screen</b>. Once installed,
                it opens like any other app and updates automatically — no App
                Store needed.
              </p>
            )}
            <button
              onClick={() => setShowHelp(false)}
              className="text-xs px-3 py-2 rounded-lg border"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            >
              Got it
            </button>
          </div>
        </ModalWrap>
      )}
    </>
  );
}

// =============================================================================
// AUTO-UPDATE (existing installs pick up new pushes automatically)
// =============================================================================
// This app's index.html already registers /sw.js on page load — we don't
// register it again here, just watch the existing registration for a new
// version becoming available. That sw.js calls self.skipWaiting() and
// self.clients.claim() on its own, so a newly-deployed version takes over
// automatically within a few seconds of a client noticing it. We can't stop
// that handover — but we CAN control when the page actually reloads to pick
// it up, which is what the "quiet moment" logic further down (inside
// CafePOS, near the other effects) does: it waits until the cart is empty
// and no modal is open before reloading, instead of yanking the screen out
// from under a mid-sale cashier.
function useAppUpdate() {
  const [controllerChanged, setControllerChanged] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let cleanupUpdateFound = () => {};
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const onUpdateFound = () => {
        const installing = reg.installing;
        if (!installing) return;
        // Nothing to do here ourselves — sw.js handles skipWaiting/claim on
        // its own; we just wait for "controllerchange" below, which is the
        // actual signal that the new version has taken over.
      };
      reg.addEventListener("updatefound", onUpdateFound);
      cleanupUpdateFound = () => reg.removeEventListener("updatefound", onUpdateFound);
      reg.update();
      const interval = setInterval(() => reg.update(), 60 * 60 * 1000);
      cleanupUpdateFound = ((prev) => () => { prev(); clearInterval(interval); })(cleanupUpdateFound);
    });

    const onControllerChange = () => setControllerChanged(true);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cleanupUpdateFound();
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return controllerChanged;
}

function UpdateBanner({ onRefreshNow }) {
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 px-4 py-2.5 rounded-full shadow-lg no-print"
      style={{ background: "var(--ink)", color: "#fff" }}
    >
      <span className="text-xs font-medium">Update ready — will apply once it's quiet.</span>
      <button
        onClick={onRefreshNow}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-semibold"
        style={{ background: "var(--primary)", color: "#fff" }}
      >
        <RefreshCw size={12} /> Refresh now
      </button>
    </div>
  );
}

function Header({ businessName, low, confirmReset, setConfirmReset, resetAll, currencyCode, changeCurrency, employees, currentEmployee, selectEmployee, openEmployeeModal }) {
  return (
    <header className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 pb-3 flex items-start justify-between no-print">
      <div>
        <img
          src={LOGO_DATA_URL}
          alt="OpSteward QuickServe POS"
          className="h-16 sm:h-20 w-auto"
          style={{ objectFit: "contain" }}
        />
        {businessName && (
          <div className="text-xs mt-1 font-medium" style={{ color: "var(--ink-soft)" }}>
            {businessName}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <EmployeeSwitcher
          employees={employees}
          currentEmployee={currentEmployee}
          selectEmployee={selectEmployee}
          openEmployeeModal={openEmployeeModal}
        />
        {low > 0 && (
          <span
            className="hidden sm:flex items-center gap-1 text-xs px-2.5 py-1 rounded-full"
            style={{ background: "#F3E3DC", color: "var(--alert)" }}
          >
            <AlertTriangle size={12} /> {low} low on stock
          </span>
        )}
        {/* Currency is set once at sign-up and permanent — shown here as a
            plain read-only badge (not a selector) so it can't be switched
            to peek at a different currency's subscription price. To change
            it, an owner would need a new account. */}
        <span
          className="text-xs px-2.5 py-1.5 rounded-full border"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)", background: "var(--surface)" }}
          title="Currency (set at sign-up, can't be changed)"
        >
          {(CURRENCIES.find((c) => c.code === currencyCode) || CURRENCIES[0]).code}{" "}
          {(CURRENCIES.find((c) => c.code === currencyCode) || CURRENCIES[0]).symbol}
        </span>
        <button
          onClick={() => (confirmReset ? resetAll() : setConfirmReset(true))}
          onBlur={() => setConfirmReset(false)}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border"
          style={{ borderColor: "var(--line)", color: confirmReset ? "var(--alert)" : "var(--ink-soft)" }}
          title="Reset to sample data"
        >
          <RotateCcw size={12} /> {confirmReset ? "Confirm reset?" : "Reset data"}
        </button>
        <InstallAppButton />
      </div>
    </header>
  );
}

function EmployeeSwitcher({ employees, currentEmployee, selectEmployee, openEmployeeModal }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const managers = employees.filter((e) => e.role === "manager");
  const staff = employees.filter((e) => e.role !== "manager");
  const renderGroup = (label, list) =>
    list.length > 0 && (
      <div key={label}>
        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--ink-soft)" }}>
          {label}
        </div>
        {list.map((e) => (
          <button
            key={e.id}
            onClick={() => { selectEmployee(e.id); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm flex items-center justify-between"
            style={{ background: currentEmployee?.id === e.id ? "var(--bg)" : "transparent" }}
          >
            {e.name}
            {currentEmployee?.id === e.id && <Check size={13} color="var(--primary)" />}
          </button>
        ))}
      </div>
    );
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border"
        style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--surface)" }}
        title="Employee on shift"
      >
        <span
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold"
          style={{ background: "var(--primary)", color: "#fff" }}
        >
          {(currentEmployee?.name || "?").charAt(0).toUpperCase()}
        </span>
        {currentEmployee?.name || "Select employee"}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1.5 w-48 rounded-xl border shadow-lg z-40 overflow-hidden"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}
        >
          <div className="pb-1">
            {renderGroup("Managers", managers)}
            {renderGroup("Staff", staff)}
          </div>
          <button
            onClick={() => { setOpen(false); openEmployeeModal(); }}
            className="w-full text-left px-3 py-2 text-sm border-t flex items-center gap-1.5"
            style={{ borderColor: "var(--line)", color: "var(--primary-dark)" }}
          >
            <Plus size={13} /> Manage employees
          </button>
        </div>
      )}
    </div>
  );
}

function EmployeeModal({ employees, currentEmployeeId, onClose, onAdd, onDelete, onSelect, onUpdatePin }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("staff");
  const [pin, setPin] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name, role, pin);
    setName("");
    setPin("");
  };
  const managers = employees.filter((e) => e.role === "manager");
  const staff = employees.filter((e) => e.role !== "manager");

  const renderRow = (e) => (
    <EmployeeRow key={e.id} employee={e} isCurrent={e.id === currentEmployeeId} onSelect={onSelect} onDelete={onDelete} onUpdatePin={onUpdatePin} />
  );

  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Employees</h3>
        <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
          Pick who's on shift — it'll stay selected for every sale until you change it again. If a shift is open, switching employees will ask you to count the drawer first so each shift stays tied to one person. Set a PIN so approvals (voids/restores) actually confirm who signed off.
        </p>
        <div className="space-y-3 mb-4">
          {managers.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: "var(--ink-soft)" }}>Managers</div>
              <div className="space-y-1.5">{managers.map(renderRow)}</div>
            </div>
          )}
          {staff.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: "var(--ink-soft)" }}>Staff</div>
              <div className="space-y-1.5">{staff.map(renderRow)}</div>
            </div>
          )}
        </div>
        <div className="space-y-3 mb-1">
          <Field label="Employee name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Maria, Jon"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
          <Field label="Category">
            <div className="flex rounded-lg border p-0.5 text-xs" style={{ borderColor: "var(--line)" }}>
              <button type="button" onClick={() => setRole("staff")} className="flex-1 py-1.5 rounded-md" style={{ background: role === "staff" ? "var(--primary)" : "transparent", color: role === "staff" ? "#fff" : "var(--ink-soft)" }}>
                Staff
              </button>
              <button type="button" onClick={() => setRole("manager")} className="flex-1 py-1.5 rounded-md" style={{ background: role === "manager" ? "var(--primary)" : "transparent", color: role === "manager" ? "#fff" : "var(--ink-soft)" }}>
                Manager
              </button>
            </div>
          </Field>
          <Field label="4-digit PIN (optional, required to approve voids)">
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="e.g. 1234"
              className="w-full border rounded-lg px-3 py-2 text-sm mono-font tracking-widest"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
          <button onClick={submit} className="w-full py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-1" style={{ background: "var(--primary)", color: "#fff" }}>
            <Plus size={14} /> Add employee
          </button>
        </div>
        <button onClick={onClose} className="w-full mt-5 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Done</button>
      </div>
    </ModalWrap>
  );
}

function EmployeeRow({ employee: e, isCurrent, onSelect, onDelete, onUpdatePin }) {
  const [editingPin, setEditingPin] = useState(false);
  const [pinVal, setPinVal] = useState("");
  const savePin = () => {
    onUpdatePin(e.id, pinVal);
    setEditingPin(false);
    setPinVal("");
  };
  return (
    <div className="rounded-lg px-3 py-2 text-sm" style={{ background: isCurrent ? "var(--bg)" : "transparent", border: "1px solid var(--line)" }}>
      <div className="flex items-center justify-between">
        <button onClick={() => onSelect(e.id)} className="flex items-center gap-1.5 flex-1 text-left">
          <span
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
            style={{ background: "var(--primary)", color: "#fff" }}
          >
            {e.name.charAt(0).toUpperCase()}
          </span>
          {e.name}
          {isCurrent && <span className="text-[10px] px-1.5 py-0.5 rounded-full ml-1" style={{ background: "#EAF0E2", color: "var(--primary-dark)" }}>On shift</span>}
        </button>
        <button onClick={() => onDelete(e.id)}><Trash2 size={13} color="var(--alert)" /></button>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 pl-6.5" style={{ paddingLeft: 26 }}>
        {editingPin ? (
          <>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pinVal}
              onChange={(ev) => setPinVal(ev.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(ev) => ev.key === "Enter" && savePin()}
              placeholder="4-digit PIN"
              className="border rounded px-2 py-1 text-xs mono-font tracking-widest w-24"
              style={{ borderColor: "var(--line)" }}
            />
            <button onClick={savePin}><Check size={13} color="var(--primary-dark)" /></button>
          </>
        ) : (
          <button
            onClick={() => { setEditingPin(true); setPinVal(""); }}
            className="text-[11px] px-2 py-0.5 rounded-full border"
            style={{ borderColor: "var(--line)", color: e.pin ? "var(--ink-soft)" : "var(--alert)" }}
          >
            {e.pin ? "PIN set · change" : "No PIN · set one"}
          </button>
        )}
      </div>
    </div>
  );
}

function NoShiftGate({ onGoToShift }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center" style={{ borderColor: "var(--line)" }}>
      <Banknote size={26} color="var(--ink-soft)" className="mx-auto mb-3" />
      <p className="text-sm font-medium mb-1">No shift is open</p>
      <p className="text-xs mb-4 max-w-xs mx-auto" style={{ color: "var(--ink-soft)" }}>
        Start a shift with your opening cash before ringing up sales, so every sale is tracked against a drawer count.
      </p>
      <button
        onClick={onGoToShift}
        className="px-4 py-2 rounded-lg text-sm font-medium"
        style={{ background: "var(--primary)", color: "#fff" }}
      >
        Open a shift
      </button>
    </div>
  );
}

function Nav({ view, setView, lowCount, shiftOpen, kitchenCount, tabsCount }) {
  const items = [
    { id: "pos", label: "POS", icon: ShoppingCart },
    { id: "tabs", label: "Tabs", icon: ClipboardList, badge: tabsCount },
    { id: "kitchen", label: "Kitchen", icon: ChefHat, badge: kitchenCount },
    { id: "products", label: "Products", icon: ReceiptIcon },
    { id: "inventory", label: "Inventory", icon: Package, badge: lowCount },
    { id: "shift", label: "Shift", icon: Banknote, dot: shiftOpen },
    { id: "history", label: "History", icon: HistoryIcon },
    { id: "reports", label: "Reports", icon: BarChart3 },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];
  return (
    <nav className="sticky top-0 z-20 no-print" style={{ background: "var(--bg)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex gap-1 border-b overflow-x-auto scrollbar-thin" style={{ borderColor: "var(--line)" }}>
          {items.map((it) => {
            const Icon = it.icon;
            const active = view === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setView(it.id)}
                className="relative flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-sm font-medium -mb-px whitespace-nowrap shrink-0"
                style={{
                  color: active ? "var(--primary-dark)" : "var(--ink-soft)",
                  borderBottom: active ? "2px solid var(--primary)" : "2px solid transparent",
                }}
              >
                <Icon size={15} />
                {it.label}
                {it.dot && (
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--primary)" }} title="Shift open" />
                )}
                {it.badge > 0 && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full ml-0.5"
                    style={{ background: "var(--alert)", color: "#fff" }}
                  >
                    {it.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

function Toast({ toast }) {
  return (
    <div
      className="fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-lg text-sm shadow-lg z-50"
      style={{
        background: toast.type === "err" ? "var(--alert)" : "var(--primary-dark)",
        color: "#fff",
      }}
    >
      {toast.msg}
    </div>
  );
}

function SectionTitle({ children, action }) {
  return (
    <div className="flex items-center justify-between mb-3 mt-2">
      <h2 className="display-font text-lg" style={{ fontWeight: 600 }}>{children}</h2>
      {action}
    </div>
  );
}

// ============== POS ==============

function POSView({
  products, categories, ingredients, posFilter, setPosFilter, addToCart, cartDetailed, changeQty, removeFromCart, clearCart,
  subtotal, discountType, setDiscountType, discountValue, setDiscountValue, discountAmount, cartTotal,
  paymentMethod, setPaymentMethod, cashReceived, setCashReceived, changeDue,
  splitPayments, splitPaymentsResolved, splitMode, setSplitMode, splitItemLegs, assignSplitItem,
  addSplitLine, removeSplitLine, updateSplitMethod, updateSplitAmount,
  checkout, checkoutError,
  paymentProof, setPaymentProof, proofProcessing, uploadPaymentProof,
  nextOrderNo, openParkModal,
}) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const cats = [{ id: "all", label: "All" }, ...categories.map((c) => ({ id: c.id, label: c.name }))];

  // Project what this cart would leave in stock, so a barista sees a warning
  // *before* checkout instead of only finding out via a shortage error.
  const stockWarnings = useMemo(() => {
    if (cartDetailed.length === 0) return [];
    const needs = {};
    cartDetailed.forEach(({ product, qty }) => {
      product.recipe.forEach((r) => {
        needs[r.ingredientId] = (needs[r.ingredientId] || 0) + r.amount * qty;
      });
    });
    return Object.entries(needs)
      .map(([ingId, needed]) => {
        const ing = ingredients.find((i) => i.id === ingId);
        if (!ing) return null;
        const remaining = +(ing.stock - needed).toFixed(2);
        if (remaining < 0) return { name: ing.name, kind: "short", remaining, unit: ing.unit };
        if (ing.low > 0 && remaining <= ing.low) return { name: ing.name, kind: "low", remaining, unit: ing.unit };
        return null;
      })
      .filter(Boolean);
  }, [cartDetailed, ingredients]);

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-2 gap-2.5 sm:gap-4 mt-2 items-start">
      <div className="min-w-0 w-full">
        <div className="flex gap-1.5 sm:gap-2 mb-3 sm:mb-4 flex-wrap">
          {cats.map((c) => (
            <button
              key={c.id}
              onClick={() => setPosFilter(c.id)}
              className="text-xs sm:text-sm px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-full border whitespace-nowrap"
              style={{
                borderColor: posFilter === c.id ? "var(--primary)" : "var(--line)",
                background: posFilter === c.id ? "var(--primary)" : "transparent",
                color: posFilter === c.id ? "#fff" : "var(--ink-soft)",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {products.length === 0 ? (
          <EmptyState text="No products yet. Add some in the Products tab." />
        ) : (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 max-h-[45vh] sm:max-h-[68vh] lg:max-h-[72vh] overflow-y-auto scrollbar-thin pr-1 pb-1 content-start">
            {products.map((p) => {
              const Icon = categoryIcon(p.category);
              return (
                <button
                  key={p.id}
                  onClick={() => addToCart(p.id)}
                  className="text-left rounded-lg p-2 sm:p-2.5 border transition-transform active:scale-[0.98]"
                  style={{ background: "var(--surface)", borderColor: "var(--line)" }}
                >
                  <Icon size={13} color="var(--primary)" className="mb-1" />
                  <div className="font-medium text-xs leading-snug truncate">{p.name}</div>
                  <div className="mono-font text-xs mt-1" style={{ color: "var(--accent)" }}>{money(p.price)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-full h-screen flex flex-col min-w-0">
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl border" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="ticket-edge-top shrink-0" />

          {/* ---- Fixed header — order title + order number, never scrolls ---- */}
          <div className="px-3 sm:px-5 pt-2 shrink-0">
            <div className="flex items-center gap-1.5 mb-3 justify-between flex-wrap">
              <div className="flex items-center gap-1.5">
                <ShoppingCart size={17} color="var(--primary)" />
                <span className="font-medium text-sm sm:text-base">Current order</span>
              </div>
              <span className="mono-font text-xs sm:text-sm px-2.5 py-0.5 rounded-full" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
                #{nextOrderNo}
              </span>
            </div>
          </div>

          {/* ---- Scrollable middle — only the order items list grows/scrolls
              here; everything else (discount, payment method, keypad,
              totals, Charge/Park buttons) lives in the fixed footer below
              so it's always reachable without scrolling past a long order. ---- */}
          <div className="flex-1 overflow-y-auto scrollbar-thin px-3 sm:px-5">
            {cartDetailed.length === 0 ? (
              <p className="text-sm py-6 text-center" style={{ color: "var(--ink-soft)" }}>Tap a product to add it.</p>
            ) : (
              <div className="mono-font text-xs sm:text-sm pr-1">
                {cartDetailed.map(({ product, qty }) => (
                  <div
                    key={product.id}
                    className="grid grid-cols-[1fr,auto,auto] grid-rows-2 items-center gap-x-2 gap-y-0.5 py-2.5 border-b last:border-b-0"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <div className="col-start-1 row-start-1 truncate leading-snug font-medium">{product.name}</div>
                    <div className="col-start-1 row-start-2 text-[10px] sm:text-xs" style={{ color: "var(--ink-soft)" }}>{money(product.price)} ea</div>

                    <div className="col-start-2 row-start-1 row-span-2 justify-self-center flex items-center gap-1 sm:gap-1.5">
                      <button onClick={() => changeQty(product.id, -1)} className="w-6 h-6 flex items-center justify-center rounded-full border shrink-0" style={{ borderColor: "var(--line)" }}><Minus size={11} /></button>
                      <span className="w-5 text-center">{qty}</span>
                      <button onClick={() => changeQty(product.id, 1)} className="w-6 h-6 flex items-center justify-center rounded-full border shrink-0" style={{ borderColor: "var(--line)" }}><Plus size={11} /></button>
                    </div>

                    <button onClick={() => removeFromCart(product.id)} className="col-start-3 row-start-1 justify-self-end"><X size={13} color="var(--ink-soft)" /></button>
                    <div className="col-start-3 row-start-2 justify-self-end text-right font-medium truncate">{money(product.price * qty)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---- Fixed footer — discount, payment method (incl. the
              numeric keypad), totals, and the Charge/Clear/Park buttons.
              Pinned below the scrollable items list so the keypad and
              Charge button are always visible, never require scrolling
              down to reach. ---- */}
          <div className="px-3 sm:px-5 pb-4 pt-2 shrink-0" style={{ borderTop: "1px solid var(--line)" }}>
            {stockWarnings.length > 0 && (
              <div className="rounded-lg px-3 py-2 mt-2.5 text-xs space-y-1" style={{ background: "#FBF1EC" }}>
                {stockWarnings.map((w) => (
                  <div key={w.name} className="flex items-center gap-1.5" style={{ color: w.kind === "short" ? "var(--alert)" : "var(--ink-soft)" }}>
                    <AlertTriangle size={11} />
                    {w.kind === "short"
                      ? `Not enough ${w.name} — short by ${Math.abs(w.remaining)}${w.unit}`
                      : `${w.name} will be low after this order (${w.remaining}${w.unit} left)`}
                  </div>
                ))}
              </div>
            )}

            {cartDetailed.length > 0 && (
              <>
                {/* Discount */}
                <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Discount</span>
                  </div>
                  <div className="flex gap-1.5">
                    {[
                      { id: "none", label: "None" },
                      { id: "percent", label: "%" },
                      { id: "amount", label: null },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setDiscountType(opt.id)}
                        className="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1"
                        style={{
                          borderColor: discountType === opt.id ? "var(--primary)" : "var(--line)",
                          background: discountType === opt.id ? "var(--primary)" : "transparent",
                          color: discountType === opt.id ? "#fff" : "var(--ink-soft)",
                        }}
                      >
                        {opt.id === "amount" ? <Coins size={13} /> : opt.label}
                      </button>
                    ))}
                    {discountType !== "none" && (
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={discountValue}
                        onChange={(e) => setDiscountValue(e.target.value)}
                        placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 50"}
                        className="flex-1 min-w-0 border rounded-lg px-2 py-1 text-xs mono-font"
                        style={{ borderColor: "var(--line)" }}
                      />
                    )}
                  </div>
                </div>

                {/* Payment method */}
                <div className="mt-3">
                  <span className="text-xs font-medium block mb-1.5" style={{ color: "var(--ink-soft)" }}>Payment method</span>
                  <div className="flex gap-1 sm:gap-1.5">
                    <button
                      onClick={() => setPaymentMethod("cash")}
                      title="Cash"
                      className="flex-1 flex items-center justify-center gap-1 sm:gap-1.5 text-xs py-1.5 rounded-lg border px-1"
                      style={{
                        borderColor: paymentMethod === "cash" ? "var(--primary)" : "var(--line)",
                        background: paymentMethod === "cash" ? "var(--primary)" : "transparent",
                        color: paymentMethod === "cash" ? "#fff" : "var(--ink-soft)",
                      }}
                    >
                      <Banknote size={13} /> <span className="hidden sm:inline">Cash</span>
                    </button>
                    <button
                      onClick={() => setPaymentMethod("online")}
                      title="Online"
                      className="flex-1 flex items-center justify-center gap-1 sm:gap-1.5 text-xs py-1.5 rounded-lg border px-1"
                      style={{
                        borderColor: paymentMethod === "online" ? "var(--primary)" : "var(--line)",
                        background: paymentMethod === "online" ? "var(--primary)" : "transparent",
                        color: paymentMethod === "online" ? "#fff" : "var(--ink-soft)",
                      }}
                    >
                      <CreditCard size={13} /> <span className="hidden sm:inline">Online</span>
                    </button>
                    <button
                      onClick={() => setPaymentMethod("split")}
                      title="Split"
                      className="flex-1 flex items-center justify-center gap-1 sm:gap-1.5 text-xs py-1.5 rounded-lg border px-1"
                      style={{
                        borderColor: paymentMethod === "split" ? "var(--primary)" : "var(--line)",
                        background: paymentMethod === "split" ? "var(--primary)" : "transparent",
                        color: paymentMethod === "split" ? "#fff" : "var(--ink-soft)",
                      }}
                    >
                      <Banknote size={13} /> <span className="hidden sm:inline">Split</span>
                    </button>
                  </div>
                </div>

                {paymentMethod === "split" && (
                  <div className="mt-2.5 space-y-2">
                    <div className="flex rounded-lg border p-0.5" style={{ borderColor: "var(--line)" }}>
                      <button
                        type="button"
                        onClick={() => setSplitMode("amount")}
                        className="flex-1 text-xs py-1 rounded-md font-medium"
                        style={{
                          background: splitMode === "amount" ? "var(--primary)" : "transparent",
                          color: splitMode === "amount" ? "#fff" : "var(--ink-soft)",
                        }}
                      >
                        By amount
                      </button>
                      <button
                        type="button"
                        onClick={() => setSplitMode("items")}
                        className="flex-1 text-xs py-1 rounded-md font-medium"
                        style={{
                          background: splitMode === "items" ? "var(--primary)" : "transparent",
                          color: splitMode === "items" ? "#fff" : "var(--ink-soft)",
                        }}
                      >
                        By item
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      {splitPaymentsResolved.map((line, idx) => {
                        const isLastAmount = splitMode === "amount" && idx === splitPayments.length - 1;
                        return (
                          <div key={idx} className="flex items-center gap-1.5">
                            <div className="flex rounded-lg border overflow-hidden shrink-0" style={{ borderColor: "var(--line)" }}>
                              <button
                                type="button"
                                onClick={() => updateSplitMethod(idx, "cash")}
                                title="Cash"
                                className="w-7 h-7 flex items-center justify-center"
                                style={{
                                  background: line.method === "cash" ? "var(--primary)" : "transparent",
                                  color: line.method === "cash" ? "#fff" : "var(--ink-soft)",
                                }}
                              >
                                <Banknote size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => updateSplitMethod(idx, "online")}
                                title="Online"
                                className="w-7 h-7 flex items-center justify-center"
                                style={{
                                  background: line.method === "online" ? "var(--primary)" : "transparent",
                                  color: line.method === "online" ? "#fff" : "var(--ink-soft)",
                                }}
                              >
                                <CreditCard size={12} />
                              </button>
                            </div>
                            {splitMode === "amount" ? (
                              isLastAmount ? (
                                <span className="flex-1 text-xs" style={{ color: "var(--ink-soft)" }}>
                                  {line.method === "cash" ? "Cash" : "Online"} (rest of total)
                                </span>
                              ) : (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={splitPayments[idx].amount}
                                  onChange={(e) => updateSplitAmount(idx, e.target.value)}
                                  placeholder={`Payment ${idx + 1} amount`}
                                  className="flex-1 min-w-0 border rounded-lg px-2.5 py-1.5 text-xs mono-font"
                                  style={{ borderColor: "var(--line)" }}
                                />
                              )
                            ) : (
                              <span className="flex-1 text-xs" style={{ color: "var(--ink-soft)" }}>
                                Payment {idx + 1} — {line.method === "cash" ? "cash" : "online"}
                              </span>
                            )}
                            <span className="mono-font text-xs whitespace-nowrap" style={{ minWidth: 56, textAlign: "right" }}>
                              {money(line.amount)}
                            </span>
                            {(splitMode === "items" || !isLastAmount) && splitPayments.length > 2 && (
                              <button type="button" onClick={() => removeSplitLine(idx)} className="w-5 h-5 flex items-center justify-center shrink-0">
                                <X size={12} color="var(--ink-soft)" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={addSplitLine}
                        className="flex items-center gap-1 text-xs font-medium"
                        style={{ color: "var(--primary)" }}
                      >
                        <Plus size={12} /> Add another payment
                      </button>
                    </div>

                    {splitMode === "items" && (
                      <div className="rounded-lg border p-2 space-y-1.5" style={{ borderColor: "var(--line)" }}>
                        <div className="text-[10px] font-medium" style={{ color: "var(--ink-soft)" }}>
                          Tap which payment covers each item
                        </div>
                        {cartDetailed.length === 0 ? (
                          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Cart is empty.</p>
                        ) : (
                          cartDetailed.map((item) => {
                            const assignedLeg = splitItemLegs[item.productId] ?? 0;
                            return (
                              <div key={item.productId} className="flex items-center justify-between gap-2">
                                <span className="text-xs truncate">{item.qty}× {item.product.name}</span>
                                <div className="flex gap-1 shrink-0">
                                  {splitPayments.map((p, legIdx) => (
                                    <button
                                      key={legIdx}
                                      type="button"
                                      onClick={() => assignSplitItem(item.productId, legIdx)}
                                      title={`Payment ${legIdx + 1} (${p.method})`}
                                      className="w-6 h-6 rounded-full text-[10px] font-semibold flex items-center justify-center border"
                                      style={{
                                        borderColor: assignedLeg === legIdx ? "var(--primary)" : "var(--line)",
                                        background: assignedLeg === legIdx ? "var(--primary)" : "transparent",
                                        color: assignedLeg === legIdx ? "#fff" : "var(--ink-soft)",
                                      }}
                                    >
                                      {legIdx + 1}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}

                {paymentMethod === "cash" && (
                  <div className="mt-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={cashReceived}
                        onChange={(e) => setCashReceived(e.target.value)}
                        placeholder="Amount received"
                        className="flex-1 border rounded-lg px-2.5 py-1.5 text-xs mono-font"
                        style={{ borderColor: "var(--line)" }}
                      />
                      <span className="text-xs mono-font whitespace-nowrap" style={{ color: changeDue < 0 ? "var(--alert)" : "var(--primary-dark)" }}>
                        {cashReceived === "" ? "Change —" : changeDue < 0 ? `Short ${money(Math.abs(changeDue))}` : `Change ${money(changeDue)}`}
                      </span>
                    </div>
                    {/* Built into the checkout layout itself (not a popup) so
                        the total/change readout above stays visible while
                        keying in the amount on a touchscreen register. */}
                    <NumericKeypad value={cashReceived} onChange={setCashReceived} />
                  </div>
                )}

                {(paymentMethod === "online" || paymentMethod === "split") && (
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Payment screenshot</span>
                      <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>Optional</span>
                    </div>
                    {paymentProof ? (
                      <div className="relative rounded-lg overflow-hidden border" style={{ borderColor: "var(--line)" }}>
                        <img src={paymentProof} alt="Payment proof" className="w-full max-h-40 object-contain" style={{ background: "var(--bg)" }} />
                        <button
                          type="button"
                          onClick={() => setPaymentProof(null)}
                          className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-full"
                          style={{ background: "rgba(43,36,32,0.65)" }}
                        >
                          <X size={13} color="#fff" />
                        </button>
                      </div>
                    ) : proofProcessing ? (
                      <div
                        className="flex items-center justify-center gap-1.5 text-xs py-3 rounded-lg border border-dashed"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                      >
                        <Loader2 size={14} className="animate-spin" /> Processing…
                      </div>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setCameraOpen(true)}
                          className="flex-1 flex items-center justify-center gap-1.5 text-xs py-2.5 rounded-lg border border-dashed"
                          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                        >
                          <Camera size={14} /> Take photo
                        </button>
                        <label
                          className="flex-1 flex items-center justify-center gap-1.5 text-xs py-2.5 rounded-lg border border-dashed cursor-pointer"
                          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                        >
                          <ImagePlus size={14} /> Choose file
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files && e.target.files[0];
                              uploadPaymentProof(file);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {checkoutError && checkoutError.kind === "stock" && (
              <div className="mt-3 text-xs rounded-lg p-2.5" style={{ background: "#F3E3DC", color: "var(--alert)" }}>
                <div className="flex items-center gap-1 font-medium mb-1"><AlertTriangle size={12} /> Not enough stock</div>
                {checkoutError.shortages.map((s) => (
                  <div key={s.name}>{s.name}: need {s.needed}{s.unit}, have {s.available}{s.unit}</div>
                ))}
              </div>
            )}
            {checkoutError && checkoutError.kind === "cash" && (
              <div className="mt-3 text-xs rounded-lg p-2.5 flex items-center gap-1" style={{ background: "#F3E3DC", color: "var(--alert)" }}>
                <AlertTriangle size={12} /> {checkoutError.message}
              </div>
            )}

            <div className="mt-3 pt-3 border-t mono-font text-sm sm:text-base" style={{ borderColor: "var(--line)" }}>
              <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
                <span>Subtotal</span><span>{money(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between" style={{ color: "var(--alert)" }}>
                  <span>Discount</span><span>-{money(discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between mt-1">
                <span className="font-medium">Total</span>
                <span className="text-lg sm:text-xl font-semibold">{money(cartTotal)}</span>
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={clearCart}
                disabled={cartDetailed.length === 0}
                className="flex-1 text-sm sm:text-base py-2 sm:py-2.5 rounded-lg border disabled:opacity-40"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                Clear
              </button>
              <button
                onClick={checkout}
                disabled={cartDetailed.length === 0}
                className="flex-[2] text-sm sm:text-base py-2 sm:py-2.5 rounded-lg font-medium disabled:opacity-40"
                style={{ background: "var(--primary)", color: "#fff" }}
              >
                Charge {cartDetailed.length > 0 ? money(cartTotal) : ""}
              </button>
            </div>
            <button
              onClick={openParkModal}
              disabled={cartDetailed.length === 0}
              className="w-full mt-2 flex items-center justify-center gap-1.5 text-sm py-2 rounded-lg border disabled:opacity-40"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              title="Send this order to the kitchen and pay for it later"
            >
              <ClipboardList size={14} /> Park as a tab (pay later)
            </button>
          </div>
          <div className="ticket-edge-bottom shrink-0" />
        </div>
      </div>

      {cameraOpen && (
        <CameraCaptureModal
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            setCameraOpen(false);
            uploadPaymentProof(file);
          }}
        />
      )}
    </div>
  );
}

function CameraCaptureModal({ onClose, onCapture }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Camera isn't available on this device or browser. Use Choose file instead.");
      return;
    }
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setReady(true);
      } catch (e) {
        if (!cancelled) setError("Couldn't access the camera. Check permissions, or use Choose file instead.");
      }
    })();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], "receipt-photo.jpg", { type: "image/jpeg" });
          onCapture(file);
        }
      },
      "image/jpeg",
      0.85
    );
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-[60]" style={{ background: "rgba(43,36,32,0.75)" }} onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm overflow-hidden" style={{ background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-4 pb-2 flex items-center justify-between">
          <span className="text-sm font-medium">Take a photo</span>
          <button onClick={onClose}><X size={16} color="var(--ink-soft)" /></button>
        </div>
        <div className="px-4">
          {error ? (
            <div className="text-xs rounded-lg p-3 mb-3" style={{ background: "#F3E3DC", color: "var(--alert)" }}>{error}</div>
          ) : (
            <div className="rounded-lg overflow-hidden mb-3 flex items-center justify-center" style={{ background: "#000", minHeight: 200 }}>
              <video ref={videoRef} playsInline muted className="w-full max-h-72 object-contain" />
            </div>
          )}
        </div>
        <div className="flex gap-2 px-4 pb-4">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>
            Cancel
          </button>
          {!error && (
            <button
              onClick={capture}
              disabled={!ready}
              className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-40"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Capture
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Builds a small, self-contained HTML page for a single sale receipt and
// sends it to the browser's print dialog. Runs in its own popup window
// rather than calling window.print() on the main app — the app's print CSS
// (see the .no-print / .print-only rules in the global <style> block) is
// built around printing the Reports page, not a receipt sitting inside a
// modal overlay, so reusing it here would risk printing the dashboard
// underneath along with the receipt. A dedicated popup keeps this simple
// and prints ONLY the receipt, every time, regardless of which screen it
// was opened from (checkout, Sales History, etc).
function printReceipt(sale) {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const itemsHTML = sale.items
    .map(
      (i) => `
        <div class="row">
          <span>${esc(i.qty)} × ${esc(i.name)}</span>
          <span>${esc(money(i.price * i.qty))}</span>
        </div>`
    )
    .join("");

  const discountHTML =
    sale.discountAmount > 0
      ? `
        <div class="row alert">
          <span>Discount${sale.discountType === "percent" ? ` (${esc(sale.discountValue)}%)` : ""}</span>
          <span>-${esc(money(sale.discountAmount))}</span>
        </div>`
      : "";

  let paymentHTML = `
    <div class="row soft"><span>Payment</span><span style="text-transform:capitalize">${esc(sale.paymentMethod || "cash")}</span></div>`;
  if (sale.paymentMethod === "cash") {
    paymentHTML += `
      <div class="row soft"><span>Cash received</span><span>${esc(money(sale.amountTendered))}</span></div>
      <div class="row soft"><span>Change</span><span>${esc(money(sale.change))}</span></div>`;
  } else if (sale.paymentMethod === "split" && sale.payments) {
    paymentHTML += sale.payments
      .map((p) => `<div class="row soft" style="text-transform:capitalize"><span>${esc(p.method)}</span><span>${esc(money(p.amount))}</span></div>`)
      .join("");
  }

  const voidedHTML = sale.voided
    ? `
      <div class="notice alert">
        <div class="bold">VOIDED — not counted in reports</div>
        <div>Reason: ${esc(sale.voidReason)}${sale.voidedAt ? ` · ${esc(new Date(sale.voidedAt).toLocaleString())}` : ""}${sale.voidedByName ? ` · by ${esc(sale.voidedByName)}` : ""}</div>
        ${sale.approvedByName ? `<div>Approved by ${esc(sale.approvedByName)}</div>` : ""}
        ${sale.voidNote ? `<div>Note: ${esc(sale.voidNote)}</div>` : ""}
      </div>`
    : "";

  const restoredHTML =
    !sale.voided && sale.restoredAt
      ? `
      <div class="notice">
        <div class="bold">Restored</div>
        <div>${esc(new Date(sale.restoredAt).toLocaleString())}${sale.restoredByName ? ` · by ${esc(sale.restoredByName)}` : ""}${sale.voidReason ? ` · originally voided (${esc(sale.voidReason)})` : ""}</div>
        ${sale.restoreApprovedByName ? `<div>Approved by ${esc(sale.restoreApprovedByName)}</div>` : ""}
      </div>`
      : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Receipt — Order #${esc(sale.orderNo)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: 'Courier New', monospace; color: #2B2420; width: 300px; }
  .center { text-align: center; }
  .store { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
  .meta { font-size: 11px; color: #6b6058; margin-top: 2px; }
  .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin: 3px 0; }
  .row.soft { color: #6b6058; }
  .row.alert { color: #B23B2E; }
  .divider { border-top: 1px dashed #999; margin: 10px 0; }
  .totals .row:last-child { font-weight: 700; font-size: 14px; padding-top: 4px; }
  .notice { font-size: 11px; margin: 10px 0; padding: 6px 8px; background: #f2f2f2; }
  .notice.alert { background: #F3E3DC; color: #B23B2E; }
  .bold { font-weight: 700; }
  .thanks { text-align: center; font-size: 12px; margin-top: 14px; }
  @media print { body { width: auto; } }
</style>
</head>
<body>
  <div class="center">
    <div class="store">The Counter</div>
    <div class="meta">Order #${esc(sale.orderNo)} · ${esc(new Date(sale.timestamp).toLocaleString())}</div>
    ${sale.employeeName ? `<div class="meta">Served by ${esc(sale.employeeName)}</div>` : ""}
    ${sale.tabLabel ? `<div class="meta">Tab: ${esc(sale.tabLabel)}</div>` : ""}
  </div>
  ${voidedHTML}
  ${restoredHTML}
  <div class="divider"></div>
  ${itemsHTML}
  <div class="divider"></div>
  <div class="totals">
    <div class="row soft"><span>Subtotal</span><span>${esc(money(sale.subtotal ?? sale.total))}</span></div>
    ${discountHTML}
    <div class="row"><span>Total</span><span>${esc(money(sale.total))}</span></div>
  </div>
  <div class="divider"></div>
  ${paymentHTML}
  <div class="thanks">Thanks for stopping by ☕</div>
</body>
</html>`;

  // A popup keeps this print job fully independent of the current page —
  // no CSS conflicts with whatever view (POS, Sales History, Reports) the
  // receipt happened to be opened from.
  const win = window.open("", "_blank", "width=380,height=640");
  if (!win) return; // popup blocked — nothing we can silently recover from here
  win.document.write(html);
  win.document.close();
  win.focus();
  // Give the popup a tick to finish rendering before invoking print, then
  // close it once the person is done with the print dialog.
  win.onload = () => {
    win.print();
  };
  win.onafterprint = () => win.close();
}

function ReceiptModal({ sale, onClose, closeLabel = "New order" }) {
  return (
    <ModalWrap onClose={onClose}>
      <div className="ticket-edge-top" />
      <div className="px-5 pt-2 pb-4">
        <div className="text-center mb-3">
          <div className="display-font text-lg" style={{ fontWeight: 600 }}>The Counter</div>
          <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Order #{sale.orderNo} · {new Date(sale.timestamp).toLocaleString()}
          </div>
          {sale.employeeName && (
            <div className="text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>
              Served by {sale.employeeName}
            </div>
          )}
          {sale.tabLabel && (
            <div className="text-xs mt-0.5" style={{ color: "var(--ink-soft)" }}>
              Tab: {sale.tabLabel}
            </div>
          )}
        </div>
        {sale.voided && (
          <div className="rounded-lg px-3 py-2 mb-3 text-xs" style={{ background: "#F3E3DC", color: "var(--alert)" }}>
            <div className="flex items-center gap-1.5 font-medium"><Ban size={12} /> Voided — not counted in reports</div>
            <div className="mt-1" style={{ color: "var(--ink-soft)" }}>
              Reason: {sale.voidReason}{sale.voidedAt ? ` · ${new Date(sale.voidedAt).toLocaleString()}` : ""}
              {sale.voidedByName ? ` · by ${sale.voidedByName}` : ""}
            </div>
            {sale.approvedByName && (
              <div className="mt-0.5" style={{ color: "var(--ink-soft)" }}>Approved by {sale.approvedByName}</div>
            )}
            {sale.voidNote && <div className="mt-0.5" style={{ color: "var(--ink-soft)" }}>Note: {sale.voidNote}</div>}
          </div>
        )}
        {!sale.voided && sale.restoredAt && (
          <div className="rounded-lg px-3 py-2 mb-3 text-xs" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
            <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--primary-dark)" }}><Undo2 size={12} /> Restored</div>
            <div className="mt-1">
              {new Date(sale.restoredAt).toLocaleString()}{sale.restoredByName ? ` · by ${sale.restoredByName}` : ""}
              {sale.voidReason ? ` · originally voided (${sale.voidReason})` : ""}
            </div>
            {sale.restoreApprovedByName && <div className="mt-0.5">Approved by {sale.restoreApprovedByName}</div>}
          </div>
        )}
        <div className="mono-font text-sm space-y-1.5 border-t border-dashed pt-3" style={{ borderColor: "var(--line)" }}>
          {sale.items.map((i, idx) => (
            <div key={idx} className="flex justify-between gap-2">
              <span>{i.qty} × {i.name}</span>
              <span>{money(i.price * i.qty)}</span>
            </div>
          ))}
        </div>
        <div className="mono-font text-sm space-y-1 border-t border-dashed mt-3 pt-3" style={{ borderColor: "var(--line)" }}>
          <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
            <span>Subtotal</span><span>{money(sale.subtotal ?? sale.total)}</span>
          </div>
          {sale.discountAmount > 0 && (
            <div className="flex justify-between" style={{ color: "var(--alert)" }}>
              <span>Discount{sale.discountType === "percent" ? ` (${sale.discountValue}%)` : ""}</span>
              <span>-{money(sale.discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold text-base pt-1">
            <span>Total</span>
            <span>{money(sale.total)}</span>
          </div>
        </div>
        <div className="mono-font text-xs space-y-1 border-t border-dashed mt-3 pt-3" style={{ borderColor: "var(--line)" }}>
          <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
            <span>Payment</span><span className="capitalize">{sale.paymentMethod || "cash"}</span>
          </div>
          {sale.paymentMethod === "cash" && (
            <>
              <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
                <span>Cash received</span><span>{money(sale.amountTendered)}</span>
              </div>
              <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
                <span>Change</span><span>{money(sale.change)}</span>
              </div>
            </>
          )}
          {sale.paymentMethod === "split" && sale.payments && (
            <>
              {sale.payments.map((p, idx) => (
                <div key={idx} className="flex justify-between capitalize" style={{ color: "var(--ink-soft)" }}>
                  <span>{p.method}</span><span>{money(p.amount)}</span>
                </div>
              ))}
            </>
          )}
        </div>
        {(sale.paymentMethod === "online" || sale.paymentMethod === "split") && sale.paymentProof && (
          <div className="mt-3 pt-3 border-t border-dashed" style={{ borderColor: "var(--line)" }}>
            <div className="text-xs mb-1.5" style={{ color: "var(--ink-soft)" }}>Payment screenshot</div>
            <img
              src={sale.paymentProof}
              alt="Payment proof"
              className="w-full max-h-56 object-contain rounded-lg border"
              style={{ borderColor: "var(--line)", background: "var(--bg)" }}
            />
          </div>
        )}
        <p className="text-center text-xs mt-4" style={{ color: "var(--ink-soft)" }}>Thanks for stopping by ☕</p>
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => printReceipt(sale)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border"
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            title="Opens this receipt in a print-ready window"
          >
            <Printer size={15} /> Print receipt
          </button>
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--primary)", color: "#fff" }}>
            {closeLabel}
          </button>
        </div>
      </div>
      <div className="ticket-edge-bottom" />
    </ModalWrap>
  );
}

const VOID_REASONS = ["Input error", "Cancelled by customer", "Duplicate order", "Other"];

// Shared approver-picker + PIN check used by both VoidSaleModal and
// RestoreSaleModal. Picking a name from the dropdown used to BE the approval;
// now the picked manager's 4-digit PIN has to be typed in and match before
// `pinOk` goes true, so an approval actually means that manager signed off.
function ApproverPinField({ approverOptions, approverId, setApproverId, pin, setPin }) {
  const approver = approverOptions.find((e) => e.id === approverId) || null;
  const hasPin = !!approver?.pin;
  return (
    <div className="space-y-2">
      <Field label="Approved by (manager)">
        {approverOptions.length > 0 ? (
          <select
            value={approverId}
            onChange={(e) => { setApproverId(e.target.value); setPin(""); }}
            className="w-full border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: "var(--line)" }}
          >
            <option value="">Select the manager who approved this…</option>
            {approverOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        ) : (
          <p className="text-xs" style={{ color: "var(--alert)" }}>No managers on file — add one under "Manage employees" before voiding or restoring.</p>
        )}
      </Field>
      {approver && (
        hasPin ? (
          <Field label={`${approver.name}'s 4-digit PIN`}>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              className="w-full border rounded-lg px-3 py-2 text-sm mono-font tracking-widest"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
        ) : (
          <p className="text-xs" style={{ color: "var(--alert)" }}>
            {approver.name} hasn't set a PIN yet — add one under "Manage employees" before they can approve.
          </p>
        )
      )}
    </div>
  );
}

function VoidSaleModal({ sale, approverOptions, onClose, onConfirm }) {
  const [reason, setReason] = useState(VOID_REASONS[0]);
  const [note, setNote] = useState("");
  const [approverId, setApproverId] = useState(approverOptions[0]?.id || "");
  const [pin, setPin] = useState("");
  // Checkbox state per item index — checked = "should be voided". Defaults:
  // if nothing on this order has been voided yet, default everything checked
  // (matches the simple "click Void → whole order" expectation). If some items
  // are already voided (managing a partial void), default to their current
  // state so opening the modal doesn't change anything until the user toggles.
  const hasAnyVoided = sale.items.some((it) => itemIsVoided(sale, it));
  const [checked, setChecked] = useState(() =>
    sale.items.map((it) => (hasAnyVoided ? itemIsVoided(sale, it) : true))
  );
  const toggle = (idx) => setChecked((c) => c.map((v, i) => (i === idx ? !v : v)));

  const voidIndices = checked.reduce((acc, v, i) => (v && !itemIsVoided(sale, sale.items[i]) ? [...acc, i] : acc), []);
  const restoreIndices = checked.reduce((acc, v, i) => (!v && itemIsVoided(sale, sale.items[i]) ? [...acc, i] : acc), []);
  const needsNote = reason === "Other" && voidIndices.length > 0;
  const needsApprover = voidIndices.length > 0 || restoreIndices.length > 0;
  const multiItem = sale.items.length > 1;
  const approver = approverOptions.find((e) => e.id === approverId) || null;
  const pinOk = !needsApprover || (!!approver && !!approver.pin && pin === approver.pin);

  const submit = () => {
    if (needsNote && !note.trim()) return;
    if (needsApprover && !pinOk) return;
    if (voidIndices.length === 0 && restoreIndices.length === 0) { onClose(); return; }
    onConfirm(voidIndices, restoreIndices, reason, note.trim(), approver?.id || null, approver?.name || null);
  };

  const allVoiding = voidIndices.length === sale.items.length && restoreIndices.length === 0;

  return (
    <ModalWrap onClose={onClose}>
      <div className="p-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>{multiItem ? "Void / restore items" : "Void sale"}</h3>
        <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
          Order #{sale.orderNo} · {money(sale.originalTotal ?? sale.total)} · {new Date(sale.timestamp).toLocaleString()}
        </p>

        {multiItem && (
          <div className="rounded-lg border mb-4 overflow-hidden" style={{ borderColor: "var(--line)" }}>
            {sale.items.map((it, idx) => (
              <label
                key={idx}
                className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer"
                style={{ borderBottom: idx < sale.items.length - 1 ? "1px solid var(--line)" : "none", background: checked[idx] ? "#FBF1EC" : "transparent" }}
              >
                <input type="checkbox" checked={checked[idx]} onChange={() => toggle(idx)} />
                <span className="flex-1">{it.qty} × {it.name}</span>
                <span className="mono-font text-xs" style={{ color: "var(--ink-soft)" }}>{money(it.price * it.qty)}</span>
              </label>
            ))}
          </div>
        )}

        <div className="rounded-lg px-3 py-2 mb-4 text-xs" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
          {multiItem
            ? (allVoiding
                ? "All items checked — this voids the whole order and returns its ingredients to stock."
                : "Checked items will be voided (ingredients returned); unchecked items that were voided will be restored (ingredients deducted again, if stock allows).")
            : "This sale will stay in Sales History marked as voided, its amount will no longer be counted in Reports, and its ingredients will be returned to stock."}
        </div>

        {needsApprover && (
          <ApproverPinField approverOptions={approverOptions} approverId={approverId} setApproverId={setApproverId} pin={pin} setPin={setPin} />
        )}

        {voidIndices.length > 0 && (
          <div className="space-y-3 mt-3">
            <Field label="Reason for voiding">
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label={needsNote ? "Note (required)" : "Note (optional)"}>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Add any details about this void…"
                className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                style={{ borderColor: "var(--line)" }}
              />
            </Field>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button
            onClick={submit}
            disabled={(needsNote && !note.trim()) || (needsApprover && !pinOk)}
            className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--alert)", color: "#fff" }}
          >
            {multiItem ? "Save changes" : "Void sale"}
          </button>
        </div>
      </div>
    </ModalWrap>
  );
}

// Voided orders can only be brought back into Reports with a manager's
// sign-off — this is a lightweight approval gate for the quick "Restore"
// action on a fully-voided order (as opposed to the per-item management
// inside VoidSaleModal, which also requires an approver when unchecking).
function RestoreSaleModal({ sale, approverOptions, onClose, onConfirm }) {
  const [approverId, setApproverId] = useState(approverOptions[0]?.id || "");
  const [pin, setPin] = useState("");
  const approver = approverOptions.find((e) => e.id === approverId) || null;
  const pinOk = !!approver && !!approver.pin && pin === approver.pin;

  const submit = () => {
    if (!pinOk) return;
    onConfirm(approver.id, approver.name);
  };

  return (
    <ModalWrap onClose={onClose}>
      <div className="p-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Restore sale</h3>
        <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
          Order #{sale.orderNo} · {money(sale.originalTotal ?? sale.total)} · {new Date(sale.timestamp).toLocaleString()}
        </p>
        <div className="rounded-lg px-3 py-2 mb-4 text-xs" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
          This will restore the sale, count it in Reports again, and deduct its ingredients from stock (if there's enough on hand).
        </div>
        <ApproverPinField approverOptions={approverOptions} approverId={approverId} setApproverId={setApproverId} pin={pin} setPin={setPin} />
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button
            onClick={submit}
            disabled={!pinOk}
            className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--primary)", color: "#fff" }}
          >
            Restore sale
          </button>
        </div>
      </div>
    </ModalWrap>
  );
}

// ============== Sales History ==============

function DateFilterBar({ mode, setMode, day, setDay, rangeStart, setRangeStart, rangeEnd, setRangeEnd }) {
  const presetRange = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setRangeStart(dateKey(start.getTime()));
    setRangeEnd(dateKey(end.getTime()));
    setMode("range");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4 mt-2">
      <div className="flex rounded-full border p-0.5" style={{ borderColor: "var(--line)" }}>
        <button onClick={() => setMode("day")} className="text-xs px-3 py-1 rounded-full" style={{ background: mode === "day" ? "var(--primary)" : "transparent", color: mode === "day" ? "#fff" : "var(--ink-soft)" }}>
          Single day
        </button>
        <button onClick={() => setMode("range")} className="text-xs px-3 py-1 rounded-full" style={{ background: mode === "range" ? "var(--primary)" : "transparent", color: mode === "range" ? "#fff" : "var(--ink-soft)" }}>
          Date range
        </button>
      </div>
      {mode === "day" ? (
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
      ) : (
        <div className="flex items-center gap-1.5">
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
          <span className="text-xs" style={{ color: "var(--ink-soft)" }}>to</span>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
        </div>
      )}
      <div className="flex items-center gap-1.5 ml-auto">
        {[
          { label: "Today", fn: () => { setDay(todayKey()); setMode("day"); } },
          { label: "7d", fn: () => presetRange(7) },
          { label: "30d", fn: () => presetRange(30) },
          { label: "90d", fn: () => presetRange(90) },
        ].map((p) => (
          <button key={p.label} onClick={p.fn} className="text-xs px-2.5 py-1 rounded-full border" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SalesHistoryView({
  historyMode, setHistoryMode, historyDay, setHistoryDay,
  historyRangeStart, setHistoryRangeStart, historyRangeEnd, setHistoryRangeEnd,
  sales, stats, openVoid, openRestore, detailSale, setDetailSale,
}) {
  return (
    <div>
      <SectionTitle>Sales history</SectionTitle>
      <DateFilterBar
        mode={historyMode} setMode={setHistoryMode}
        day={historyDay} setDay={setHistoryDay}
        rangeStart={historyRangeStart} setRangeStart={setHistoryRangeStart}
        rangeEnd={historyRangeEnd} setRangeEnd={setHistoryRangeEnd}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Active sales" value={stats.activeCount} />
        <Stat label="Active revenue" value={money(stats.activeRevenue)} accent />
        <Stat label="Voided sales" value={stats.voidedCount} />
        <Stat label="Voided amount" value={money(stats.voidedRevenue)} />
      </div>

      {sales.length === 0 ? (
        <EmptyState text="No sales in this period." />
      ) : (
        <div className="space-y-2">
          {sales.map((s) => (
            <div
              key={s.id}
              className="rounded-xl border p-3.5"
              style={{ borderColor: "var(--line)", background: "var(--surface)", opacity: s.voided ? 0.75 : 1 }}
            >
              <div className="flex items-start justify-between gap-3">
                <button className="text-left flex-1 min-w-0" onClick={() => setDetailSale(s)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">Order #{s.orderNo}</span>
                    <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      {new Date(s.timestamp).toLocaleString()}
                    </span>
                    {s.employeeName && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
                        {s.employeeName}
                      </span>
                    )}
                    {s.voided ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1" style={{ background: "#F3E3DC", color: "var(--alert)" }}>
                        <Ban size={10} /> Voided
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "#EAF0E2", color: "var(--primary-dark)" }}>
                        Active
                      </span>
                    )}
                    {(s.paymentMethod === "online" || s.paymentMethod === "split") && s.paymentProof && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>
                        <ImagePlus size={10} /> Proof attached
                      </span>
                    )}
                  </div>
                  <div className="text-xs mt-1 truncate" style={{ color: "var(--ink-soft)" }}>
                    {s.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}
                  </div>
                  {(s.paymentMethod === "online" || s.paymentMethod === "split") && s.paymentProof && (
                    <img
                      src={s.paymentProof}
                      alt="Payment proof"
                      className="mt-1.5 h-12 w-12 object-cover rounded-lg border"
                      style={{ borderColor: "var(--line)" }}
                    />
                  )}
                  {s.voided && (
                    <div className="text-xs mt-1.5 flex items-start gap-1" style={{ color: "var(--alert)" }}>
                      <StickyNote size={12} className="mt-0.5 shrink-0" />
                      <span>
                        {s.voidReason}
                        {s.voidNote ? ` — ${s.voidNote}` : ""}
                        {s.voidedByName ? ` (by ${s.voidedByName})` : ""}
                        {s.approvedByName ? ` · approved by ${s.approvedByName}` : ""}
                      </span>
                    </div>
                  )}
                </button>
                <div className="text-right shrink-0">
                  <div className={`mono-font font-semibold text-sm ${s.voided ? "line-through" : ""}`} style={{ color: s.voided ? "var(--ink-soft)" : "var(--ink)" }}>
                    {money(s.total)}
                  </div>
                  <div className="mt-1.5">
                    {s.voided ? (
                      <button onClick={() => openRestore(s)} className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border" style={{ borderColor: "var(--line)", color: "var(--primary-dark)" }}>
                        <Undo2 size={12} /> Restore
                      </button>
                    ) : (
                      <button onClick={() => openVoid(s)} className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border" style={{ borderColor: "var(--line)", color: "var(--alert)" }}>
                        <Ban size={12} /> Void
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============== Kitchen board ==============
// A simple ticket rail: every order rung in at the POS lands here as
// "Preparing" with its line items unchecked. Staff tap items off one by one
// as they're made; once every active item on an order is checked, it moves
// itself to "Completed" (today's completions only — older ones live in Sales
// history/Reports). A manual complete/reopen is always available too, for
// orders that don't need a full checklist or need to be pulled back.
function KitchenView({ preparing, completed, toggleItemPrepared, setOrderStatus }) {
  const [tab, setTab] = useState("preparing");
  const list = tab === "preparing" ? preparing : completed;

  return (
    <div>
      <SectionTitle
        action={
          <div className="flex rounded-lg border p-0.5 text-xs" style={{ borderColor: "var(--line)" }}>
            <button
              onClick={() => setTab("preparing")}
              className="px-3 py-1.5 rounded-md flex items-center gap-1.5"
              style={{ background: tab === "preparing" ? "var(--primary)" : "transparent", color: tab === "preparing" ? "#fff" : "var(--ink-soft)" }}
            >
              Preparing
              {preparing.length > 0 && (
                <span
                  className="text-[10px] px-1.5 rounded-full"
                  style={{ background: tab === "preparing" ? "rgba(255,255,255,0.25)" : "var(--alert)", color: tab === "preparing" ? "#fff" : "#fff" }}
                >
                  {preparing.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab("completed")}
              className="px-3 py-1.5 rounded-md flex items-center gap-1.5"
              style={{ background: tab === "completed" ? "var(--primary)" : "transparent", color: tab === "completed" ? "#fff" : "var(--ink-soft)" }}
            >
              Completed today
              {completed.length > 0 && (
                <span
                  className="text-[10px] px-1.5 rounded-full"
                  style={{ background: tab === "completed" ? "rgba(255,255,255,0.25)" : "var(--bg)", color: tab === "completed" ? "#fff" : "var(--ink-soft)" }}
                >
                  {completed.length}
                </span>
              )}
            </button>
          </div>
        }
      >
        Kitchen
      </SectionTitle>

      {list.length === 0 ? (
        <EmptyState
          text={
            tab === "preparing"
              ? "No orders in the queue. New orders from the POS show up here as soon as they're rung in."
              : "No completed orders yet today."
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {list.map((s) => (
            <KitchenOrderCard key={s.id} sale={s} toggleItemPrepared={toggleItemPrepared} setOrderStatus={setOrderStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

function KitchenOrderCard({ sale, toggleItemPrepared, setOrderStatus }) {
  const activeItems = sale.items.filter((it) => !itemIsVoided(sale, it));
  const voidedCount = sale.items.length - activeItems.length;
  const readyCount = activeItems.filter((it) => it.prepared).length;
  const allReady = activeItems.length > 0 && readyCount === activeItems.length;
  const isCompleted = sale.status === "completed";

  return (
    <div className="rounded-xl border p-3.5 flex flex-col" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0">
          <div className="font-medium text-sm">Order #{sale.orderNo}</div>
          <div className="text-xs truncate" style={{ color: "var(--ink-soft)" }}>
            {new Date(sale.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {sale.employeeName ? ` · ${sale.employeeName}` : ""}
          </div>
        </div>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
          style={{ background: isCompleted ? "#EAF0E2" : "#FBF0DA", color: isCompleted ? "var(--primary-dark)" : "var(--accent)" }}
        >
          {isCompleted ? "Completed" : `${readyCount}/${activeItems.length} ready`}
        </span>
      </div>

      <div className="space-y-1 mb-3 flex-1">
        {activeItems.map((it) => (
          <button
            key={it.productId}
            onClick={() => toggleItemPrepared(sale.id, it.productId)}
            className="w-full flex items-center gap-2 text-left text-sm py-0.5"
          >
            {it.prepared ? <CheckCircle2 size={16} color="var(--primary)" className="shrink-0" /> : <Circle size={16} color="var(--line)" className="shrink-0" />}
            <span className={`truncate ${it.prepared ? "line-through" : ""}`} style={{ color: it.prepared ? "var(--ink-soft)" : "var(--ink)" }}>
              {it.qty}× {it.name}
            </span>
          </button>
        ))}
        {voidedCount > 0 && (
          <div className="text-xs italic pt-0.5" style={{ color: "var(--ink-soft)" }}>
            {voidedCount} item{voidedCount > 1 ? "s" : ""} voided — not shown
          </div>
        )}
      </div>

      {isCompleted ? (
        <button
          onClick={() => setOrderStatus(sale.id, "preparing")}
          className="flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-lg border"
          style={{ borderColor: "var(--line)", color: "var(--primary-dark)" }}
        >
          <Undo2 size={12} /> Move back to preparing
        </button>
      ) : (
        <button
          onClick={() => setOrderStatus(sale.id, "completed")}
          className="flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-lg font-medium"
          style={{
            background: allReady ? "var(--primary)" : "var(--bg)",
            color: allReady ? "#fff" : "var(--ink-soft)",
            border: allReady ? "none" : "1px solid var(--line)",
          }}
        >
          <Check size={12} /> Mark order complete
        </button>
      )}
    </div>
  );
}

// ============== Tabs (parked orders) ==============
// A tab is a cart already sent to the kitchen (ingredients deducted) that
// hasn't been paid yet. Opened from the POS ("Park as a tab"), edited here
// (add/remove items, cross items off as they're prepared — same idea as
// the Kitchen board's checklist), then settled for payment once the
// customer's ready to leave. See parkOrder()/settleTab() in App above.

function ParkOrderModal({ nextOrderNo, onClose, onConfirm }) {
  const [label, setLabel] = useState("");
  const submit = () => onConfirm(label);
  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Park this order as a tab</h3>
        <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
          Sends it to the kitchen now (ingredients are deducted) but doesn't
          charge anything yet. Settle it for payment later from the Tabs tab.
        </p>
        <label className="text-xs font-medium mb-1 block" style={{ color: "var(--ink-soft)" }}>
          Table / customer name
        </label>
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={`e.g. Table 5 (or leave blank for "Tab #${nextOrderNo}")`}
          className="w-full border rounded-lg px-3 py-2 text-sm mb-4"
          style={{ borderColor: "var(--line)" }}
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>
            Cancel
          </button>
          <button onClick={submit} className="flex-[2] py-2 rounded-lg text-sm font-medium" style={{ background: "var(--primary)", color: "#fff" }}>
            Open tab
          </button>
        </div>
      </div>
    </ModalWrap>
  );
}

// Every open (unpaid) tab lives in one list here, regardless of whether its
// items are all checked off — "Mark order complete" below only tracks
// kitchen prep (crossed-out items, same idea as the Kitchen board), it does
// NOT move the tab anywhere. A tab only ever leaves this list two ways:
// settleTab() (the bill actually gets paid — it becomes a `sale` and moves
// over to the Kitchen board / Sales history) or cancelTab(). Everything
// about a tab — item list, prepared checklist, adding items, marking
// complete, cancelling, settling — happens right on its card here, same as
// a Kitchen order card. There's no full-screen popup to open.
function TabsView({
  tabs, products, categories, onRename, onAddItem, onIncrement, onDecrement,
  onRemoveItem, onTogglePrepared, onSetStatus, onCancelTab, onSettle,
}) {
  const list = tabs.slice().sort((a, b) => a.openedAt - b.openedAt);

  return (
    <div>
      <SectionTitle>Tabs</SectionTitle>
      {list.length === 0 ? (
        <EmptyState text={`No open tabs. Use "Park as a tab" on the POS screen for a table that's eating now and paying later.`} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
          {list.map((t) => (
            <TabCard
              key={t.id}
              tab={t}
              products={products}
              categories={categories}
              onRename={onRename}
              onAddItem={onAddItem}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
              onRemoveItem={onRemoveItem}
              onTogglePrepared={onTogglePrepared}
              onSetStatus={onSetStatus}
              onCancelTab={onCancelTab}
              onSettle={onSettle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// A single tab, fully self-contained — item checklist, an expandable
// "Add item" product picker, mark-complete, cancel, and settle — all inline
// on the card itself. Mirrors KitchenOrderCard's "no popup, just tap on the
// card" feel, extended with the add-item picker a tab needs that a kitchen
// order doesn't.
function TabCard({
  tab, products, categories, onRename, onAddItem, onIncrement, onDecrement,
  onRemoveItem, onTogglePrepared, onSetStatus, onCancelTab, onSettle,
}) {
  const [labelDraft, setLabelDraft] = useState(tab.label);
  const [editingLabel, setEditingLabel] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Every add/remove/qty/prepared change is already saved to storage the
  // instant it happens (see persistParkedOrders in App) — there's nothing
  // that can be lost. This just gives an explicit, visible confirmation
  // after adding an item, since it's easy to miss on a busy counter.
  const [justSaved, setJustSaved] = useState(false);
  const saveTimerRef = useRef(null);
  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);

  const total = tab.items.reduce((s, it) => s + it.price * it.qty, 0);
  const readyCount = tab.items.filter((it) => it.prepared).length;
  const isCompleted = tab.status === "completed";
  const cats = [{ id: "all", label: "All" }, ...categories.map((c) => ({ id: c.id, label: c.name }))];
  const filteredProducts = filter === "all" ? products : products.filter((p) => p.category === filter);

  const saveLabel = () => {
    const trimmed = labelDraft.trim();
    if (trimmed && trimmed !== tab.label) onRename(tab.id, trimmed);
    else setLabelDraft(tab.label);
    setEditingLabel(false);
  };

  const addItem = (productId) => {
    onAddItem(tab.id, productId);
    setJustSaved(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => setJustSaved(false), 1600);
  };

  return (
    <div className="rounded-xl border p-3.5 flex flex-col" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          {editingLabel ? (
            <input
              autoFocus
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveLabel()}
              onBlur={saveLabel}
              className="text-sm font-medium border rounded-lg px-2 py-1 min-w-0 w-full"
              style={{ borderColor: "var(--line)" }}
            />
          ) : (
            <button
              onClick={() => { setLabelDraft(tab.label); setEditingLabel(true); }}
              className="flex items-center gap-1 text-sm font-medium truncate"
              style={{ color: isCompleted ? "var(--ink-soft)" : "var(--ink)" }}
            >
              <span className={`truncate ${isCompleted ? "line-through" : ""}`}>{tab.label}</span>
              <Pencil size={11} color="var(--ink-soft)" className="shrink-0" />
            </button>
          )}
          <div className="text-xs truncate mt-0.5" style={{ color: "var(--ink-soft)" }}>
            Order #{tab.orderNo} · opened{" "}
            {new Date(tab.openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 font-medium"
          style={{
            background: isCompleted ? "#EAF0E2" : readyCount === tab.items.length && tab.items.length > 0 ? "#EAF0E2" : "#FBF0DA",
            color: isCompleted || (readyCount === tab.items.length && tab.items.length > 0) ? "var(--primary-dark)" : "var(--accent)",
          }}
        >
          {isCompleted ? "Completed" : tab.items.length ? `${readyCount}/${tab.items.length} ready` : "empty"}
        </span>
      </div>

      {/* ---- Item checklist — same cross-out-as-prepared idea as Kitchen ---- */}
      {tab.items.length === 0 ? (
        <p className="text-xs py-2" style={{ color: "var(--ink-soft)" }}>
          No items yet — tap "Add item" below.
        </p>
      ) : (
        <div className="space-y-1 mb-1">
          {tab.items.map((it) => (
            <div key={it.productId} className="flex items-center gap-2 py-1 border-b last:border-b-0" style={{ borderColor: "var(--line)" }}>
              <button onClick={() => onTogglePrepared(tab.id, it.productId)} className="shrink-0">
                {it.prepared ? <CheckCircle2 size={16} color="var(--primary)" /> : <Circle size={16} color="var(--line)" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-sm truncate ${it.prepared ? "line-through" : ""}`} style={{ color: it.prepared ? "var(--ink-soft)" : "var(--ink)" }}>
                  {it.qty}× {it.name}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => onDecrement(tab.id, it.productId)} className="w-5 h-5 flex items-center justify-center rounded-full border" style={{ borderColor: "var(--line)" }}>
                  <Minus size={10} />
                </button>
                <button onClick={() => onIncrement(tab.id, it.productId)} className="w-5 h-5 flex items-center justify-center rounded-full border" style={{ borderColor: "var(--line)" }}>
                  <Plus size={10} />
                </button>
              </div>
              <button onClick={() => onRemoveItem(tab.id, it.productId)} className="shrink-0">
                <X size={12} color="var(--ink-soft)" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- Add item — expands a category-filtered product picker right
          on the card, no popup. ---- */}
      <div className="mt-1">
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="w-full flex items-center justify-center gap-1 text-xs py-1.5 rounded-lg border"
          style={{ borderColor: "var(--line)", color: "var(--primary-dark)" }}
        >
          {addOpen ? <ChevronUp size={12} /> : <PlusCircle size={12} />}
          {addOpen ? "Hide products" : "Add item"}
          {justSaved && !addOpen && (
            <span className="flex items-center gap-0.5 ml-1" style={{ color: "var(--primary-dark)" }}>
              <Check size={11} /> Saved
            </span>
          )}
        </button>
        {addOpen && (
          <div className="mt-2 rounded-lg border p-2" style={{ borderColor: "var(--line)", background: "var(--bg)" }}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="flex gap-1 flex-wrap">
                {cats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setFilter(c.id)}
                    className="text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap"
                    style={{
                      borderColor: filter === c.id ? "var(--primary)" : "var(--line)",
                      background: filter === c.id ? "var(--primary)" : "var(--surface)",
                      color: filter === c.id ? "#fff" : "var(--ink-soft)",
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {justSaved && (
                <span className="text-[10px] flex items-center gap-0.5 font-medium shrink-0" style={{ color: "var(--primary-dark)" }}>
                  <Check size={11} /> Saved
                </span>
              )}
            </div>
            {filteredProducts.length === 0 ? (
              <p className="text-[11px] py-2 text-center" style={{ color: "var(--ink-soft)" }}>No products in this category.</p>
            ) : (
              <div className="grid gap-1.5 grid-cols-2 max-h-56 overflow-y-auto scrollbar-thin pr-0.5">
                {filteredProducts.map((p) => {
                  const Icon = categoryIcon(p.category);
                  return (
                    <button
                      key={p.id}
                      onClick={() => addItem(p.id)}
                      className="text-left rounded-lg p-2 border transition-transform active:scale-[0.98]"
                      style={{ background: "var(--surface)", borderColor: "var(--line)" }}
                    >
                      <Icon size={12} color="var(--primary)" className="mb-1" />
                      <div className="font-medium text-[11px] leading-snug truncate">{p.name}</div>
                      <div className="mono-font text-[11px] mt-0.5" style={{ color: "var(--accent)" }}>{money(p.price)}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`flex justify-between mono-font text-sm mt-2 pt-2 border-t ${isCompleted ? "line-through" : ""}`} style={{ borderColor: "var(--line)", color: isCompleted ? "var(--ink-soft)" : "inherit" }}>
        <span className="font-medium">Total so far</span>
        <span className="text-lg font-semibold">{money(total)}</span>
      </div>
      <div className="text-[10px] -mt-1 mb-1" style={{ color: "var(--ink-soft)" }}>not paid yet</div>

      {/* ---- Mark order complete — same idea as the Kitchen board: cross
          the whole tab out as done even though it hasn't been paid yet.
          Independent of settling the bill. ---- */}
      {tab.items.length > 0 && (
        isCompleted ? (
          <button
            onClick={() => onSetStatus(tab.id, "preparing")}
            className="w-full mt-1 flex items-center justify-center gap-1 text-xs py-2 rounded-lg border"
            style={{ borderColor: "var(--line)", color: "var(--primary-dark)" }}
          >
            <Undo2 size={12} /> Move back to preparing
          </button>
        ) : (
          <button
            onClick={() => onSetStatus(tab.id, "completed")}
            className="w-full mt-1 flex items-center justify-center gap-1 text-xs py-2 rounded-lg font-medium"
            style={{
              background: readyCount === tab.items.length ? "var(--primary)" : "var(--bg)",
              color: readyCount === tab.items.length ? "#fff" : "var(--ink-soft)",
              border: readyCount === tab.items.length ? "none" : "1px solid var(--line)",
            }}
          >
            <Check size={12} /> Mark order complete
          </button>
        )
      )}

      <div className="flex gap-2 mt-2">
        {confirmCancel ? (
          <>
            <button
              onClick={() => setConfirmCancel(false)}
              className="flex-1 text-xs py-2 rounded-lg border"
              style={{ borderColor: "var(--line)" }}
            >
              Never mind
            </button>
            <button
              onClick={() => onCancelTab(tab.id)}
              className="flex-1 text-xs py-2 rounded-lg font-medium"
              style={{ background: "var(--alert)", color: "#fff" }}
            >
              Confirm cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirmCancel(true)}
              className="flex-1 flex items-center justify-center gap-1 text-xs py-2 rounded-lg border"
              style={{ borderColor: "var(--line)", color: "var(--alert)" }}
            >
              <Ban size={12} /> Cancel tab
            </button>
            <button
              onClick={() => onSettle(tab)}
              disabled={tab.items.length === 0}
              className="flex-[2] text-xs py-2 rounded-lg font-medium disabled:opacity-40"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Settle bill — {money(total)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// A condensed, self-contained payment panel for closing out a tab — mirrors
// the POS checkout panel's cash/online/split logic, but works off the
// tab's fixed item list instead of the live `cart` (items are edited
// directly on the tab's card in TabsView, not here) and never touches
// ingredient stock, since that was already deducted as items were added.
function SettleTabModal({ tab, onClose, onConfirm }) {
  const [discountType, setDiscountType] = useState("none"); // 'none' | 'percent' | 'amount'
  const [discountValue, setDiscountValue] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [cashReceived, setCashReceived] = useState("");
  const [splitPayments, setSplitPayments] = useState([
    { method: "cash", amount: "" },
    { method: "online", amount: "" },
  ]);
  const [paymentProof, setPaymentProof] = useState(null);
  const [proofProcessing, setProofProcessing] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState(null);

  const subtotal = tab.items.reduce((s, it) => s + it.price * it.qty, 0);
  const discountAmount = useMemo(() => {
    const v = parseFloat(discountValue) || 0;
    if (v <= 0) return 0;
    if (discountType === "percent") return Math.min(subtotal, (subtotal * v) / 100);
    if (discountType === "amount") return Math.min(subtotal, v);
    return 0;
  }, [discountType, discountValue, subtotal]);
  const total = Math.max(0, +(subtotal - discountAmount).toFixed(2));
  const changeDue = paymentMethod === "cash" ? +((parseFloat(cashReceived) || 0) - total).toFixed(2) : 0;

  // Same last-leg-takes-the-remainder trick as the POS checkout panel, just
  // limited to typed amounts (no per-item split — the tab is already a
  // fixed list by the time it reaches this screen).
  const splitResolved = (() => {
    if (paymentMethod !== "split") return [];
    const manualTotal = splitPayments.slice(0, -1).reduce((s, p) => s + Math.max(0, parseFloat(p.amount) || 0), 0);
    const lastAmount = Math.max(0, +(total - manualTotal).toFixed(2));
    return splitPayments.map((p, idx) => ({
      method: p.method,
      amount: idx === splitPayments.length - 1 ? lastAmount : +Math.max(0, parseFloat(p.amount) || 0).toFixed(2),
    }));
  })();
  const addSplitLine = () =>
    setSplitPayments((prev) => [...prev, { method: prev[prev.length - 1].method === "cash" ? "online" : "cash", amount: "" }]);
  const removeSplitLine = (idx) => {
    if (splitPayments.length <= 2) return;
    setSplitPayments((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateSplitMethod = (idx, method) => setSplitPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, method } : p)));
  const updateSplitAmount = (idx, amount) => setSplitPayments((prev) => prev.map((p, i) => (i === idx ? { ...p, amount } : p)));

  const uploadProof = async (file) => {
    if (!file) return;
    setProofProcessing(true);
    try {
      const dataUrl = await fileToResizedDataURL(file);
      setPaymentProof(dataUrl);
    } catch {
      setError("Couldn't read that image — try a different file.");
    } finally {
      setProofProcessing(false);
    }
  };

  const submit = () => {
    setError(null);
    if (tab.items.length === 0) { setError("This tab has no items."); return; }
    if (paymentMethod === "cash" && (parseFloat(cashReceived) || 0) < total) {
      setError("Cash received is less than the total due.");
      return;
    }
    if (paymentMethod === "split") {
      const covered = splitResolved.length >= 2 && splitResolved.every((p) => p.amount > 0);
      if (!covered) {
        setError("Enter payment amounts that add up to less than the total, with something left over for the last payment.");
        return;
      }
    }
    const amountTendered = paymentMethod === "cash" ? (parseFloat(cashReceived) || 0) : total;
    onConfirm({
      discountType,
      discountValue: parseFloat(discountValue) || 0,
      discountAmount,
      paymentMethod,
      payments: paymentMethod === "split" ? splitResolved : null,
      amountTendered,
      paymentProof: (paymentMethod === "online" || paymentMethod === "split") ? paymentProof : null,
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(43,36,32,0.55)" }} onClick={onClose}>
      <div
        className="rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin"
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-2 text-sm font-medium min-w-0">
            <CreditCard size={15} className="shrink-0" /> <span className="truncate">Settle "{tab.label}"</span>
          </div>
          <button onClick={onClose} className="shrink-0" style={{ color: "var(--ink-soft)" }}><X size={16} /></button>
        </div>

        <div className="px-5 py-4">
          <div className="mono-font text-xs mb-4 max-h-32 overflow-y-auto scrollbar-thin pr-1">
            {tab.items.map((it) => (
              <div key={it.productId} className="flex justify-between py-0.5">
                <span>{it.qty}× {it.name}</span>
                <span>{money(it.price * it.qty)}</span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 mb-3">
            <Tag size={13} color="var(--ink-soft)" className="shrink-0" />
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-sm"
              style={{ borderColor: "var(--line)" }}
            >
              <option value="none">No discount</option>
              <option value="percent">% off</option>
              <option value="amount">Amount off</option>
            </select>
            {discountType !== "none" && (
              <input
                type="number"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountType === "percent" ? "e.g. 10" : "e.g. 50"}
                className="flex-1 border rounded-lg px-2 py-1.5 text-sm min-w-0"
                style={{ borderColor: "var(--line)" }}
              />
            )}
          </div>

          <div className="mono-font text-sm mb-4 pt-2 border-t" style={{ borderColor: "var(--line)" }}>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>Subtotal</span><span>{money(subtotal)}</span>
            </div>
            {discountAmount > 0 && (
              <div className="flex justify-between" style={{ color: "var(--alert)" }}>
                <span>Discount</span><span>-{money(discountAmount)}</span>
              </div>
            )}
            <div className="flex justify-between mt-1">
              <span className="font-medium">Total due</span>
              <span className="text-lg font-semibold">{money(total)}</span>
            </div>
          </div>

          <div className="flex rounded-lg border p-0.5 text-xs mb-3" style={{ borderColor: "var(--line)" }}>
            {["cash", "online", "split"].map((m) => (
              <button
                key={m}
                onClick={() => setPaymentMethod(m)}
                className="flex-1 px-2 py-1.5 rounded-md capitalize"
                style={{ background: paymentMethod === m ? "var(--primary)" : "transparent", color: paymentMethod === m ? "#fff" : "var(--ink-soft)" }}
              >
                {m}
              </button>
            ))}
          </div>

          {paymentMethod === "cash" && (
            <div className="mb-3">
              <label className="text-xs font-medium mb-1 block" style={{ color: "var(--ink-soft)" }}>Amount received</label>
              <input
                type="number"
                value={cashReceived}
                onChange={(e) => setCashReceived(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                style={{ borderColor: "var(--line)" }}
              />
              {cashReceived !== "" && (
                <p className="text-xs mt-1" style={{ color: "var(--ink-soft)" }}>
                  Change due: {money(Math.max(0, changeDue))}
                </p>
              )}
              {/* Embedded directly in the settle-tab layout, not a popup, so
                  the running total stays visible while entering the amount. */}
              <NumericKeypad value={cashReceived} onChange={setCashReceived} />
            </div>
          )}

          {paymentMethod === "online" && (
            <div className="mb-3">
              <p className="text-xs mb-2" style={{ color: "var(--ink-soft)" }}>Optional: attach a screenshot of the payment.</p>
              <div className="flex gap-2">
                <label
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg border cursor-pointer"
                  style={{ borderColor: "var(--line)" }}
                >
                  <ImagePlus size={13} /> Upload
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadProof(e.target.files?.[0])} />
                </label>
                <button
                  onClick={() => setCameraOpen(true)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg border"
                  style={{ borderColor: "var(--line)" }}
                >
                  <Camera size={13} /> Camera
                </button>
              </div>
              {proofProcessing && <p className="text-xs mt-1" style={{ color: "var(--ink-soft)" }}>Processing…</p>}
              {paymentProof && <img src={paymentProof} alt="Payment proof" className="mt-2 rounded-lg max-h-32" />}
            </div>
          )}

          {paymentMethod === "split" && (
            <div className="mb-3 space-y-2">
              {splitPayments.map((p, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={p.method}
                    onChange={(e) => updateSplitMethod(idx, e.target.value)}
                    className="border rounded-lg px-2 py-1.5 text-xs"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <option value="cash">Cash</option>
                    <option value="online">Online</option>
                  </select>
                  <input
                    type="number"
                    value={idx === splitPayments.length - 1 ? "" : p.amount}
                    disabled={idx === splitPayments.length - 1}
                    onChange={(e) => updateSplitAmount(idx, e.target.value)}
                    placeholder={idx === splitPayments.length - 1 ? `${money(splitResolved[idx]?.amount || 0)} (remainder)` : "Amount"}
                    className="flex-1 border rounded-lg px-2 py-1.5 text-xs disabled:opacity-60 min-w-0"
                    style={{ borderColor: "var(--line)" }}
                  />
                  {splitPayments.length > 2 && (
                    <button onClick={() => removeSplitLine(idx)} className="shrink-0"><X size={13} color="var(--ink-soft)" /></button>
                  )}
                </div>
              ))}
              <button onClick={addSplitLine} className="text-xs flex items-center gap-1" style={{ color: "var(--primary)" }}>
                <Plus size={12} /> Add another payment
              </button>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1.5 text-xs mb-3 px-2.5 py-2 rounded-lg" style={{ background: "#FBEAE5", color: "var(--alert)" }}>
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <button onClick={submit} className="w-full py-2.5 rounded-lg text-sm font-medium" style={{ background: "var(--primary)", color: "#fff" }}>
            Confirm payment — {money(total)}
          </button>
        </div>
      </div>

      {cameraOpen && (
        <CameraCaptureModal
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => { setCameraOpen(false); uploadProof(file); }}
        />
      )}
    </div>
  );
}

// ============== Products ==============

function ProductsView({ products, ingredients, categories, productCost, openNew, openEdit, deleteProduct, openCategories }) {
  const ingredientMap = Object.fromEntries(ingredients.map((i) => [i.id, i]));
  const categoryMap = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  return (
    <div>
      <SectionTitle
        action={
          <div className="flex items-center gap-2">
            <button onClick={openCategories} className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <Tag size={14} /> Categories
            </button>
            <button onClick={openNew} className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg" style={{ background: "var(--primary)", color: "#fff" }}>
              <Plus size={14} /> Add product
            </button>
          </div>
        }
      >
        Menu items
      </SectionTitle>
      {products.length === 0 ? (
        <EmptyState text="No products yet. Add your first drink or food item." />
      ) : (
        <div className="space-y-2">
          {products.map((p) => {
            const cost = productCost(p);
            const margin = p.price - cost;
            const Icon = categoryIcon(p.category);
            return (
              <div key={p.id} className="rounded-xl border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--line)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <Icon size={16} color="var(--primary)" className="mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{p.name}</div>
                      <div className="text-xs mt-0.5" style={{ color: p.recipe.length === 0 ? "var(--alert)" : "var(--ink-soft)" }}>
                        {categoryMap[p.category] || p.category} · {p.recipe.map((r) => {
                          const ing = ingredientMap[r.ingredientId];
                          return ing ? `${r.amount}${ing.unit} ${ing.name}` : "missing ingredient";
                        }).join(" · ") || "No recipe set — selling this won't reduce any inventory"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openEdit(p)} className="w-7 h-7 flex items-center justify-center rounded-full border" style={{ borderColor: "var(--line)" }}><Pencil size={12} /></button>
                    <ConfirmDeleteButton onConfirm={() => deleteProduct(p.id)} />
                  </div>
                </div>
                <div className="flex gap-4 mt-3 mono-font text-xs pt-2.5 border-t" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <span>Price <b style={{ color: "var(--ink)" }}>{money(p.price)}</b></span>
                  <span>Cost <b style={{ color: "var(--ink)" }}>{money(cost)}</b></span>
                  <span>Margin <b style={{ color: margin >= 0 ? "var(--primary-dark)" : "var(--alert)" }}>{money(margin)}</b></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryModal({ categories, onClose, onAdd, onDelete }) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name);
    setName("");
  };
  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-4" style={{ fontWeight: 600 }}>Categories</h3>
        <div className="space-y-1.5 mb-4">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm" style={{ background: "var(--bg)" }}>
              <span className="flex items-center gap-1.5">
                <Tag size={12} color="var(--ink-soft)" /> {c.name}
              </span>
              <ConfirmDeleteButton onConfirm={() => onDelete(c.id)} compact size={13} />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Desserts, Merch"
            className="flex-1 border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: "var(--line)" }}
          />
          <button onClick={submit} className="px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1" style={{ background: "var(--primary)", color: "#fff" }}>
            <Plus size={14} /> Add
          </button>
        </div>
        <button onClick={onClose} className="w-full mt-5 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Done</button>
      </div>
    </ModalWrap>
  );
}

function ProductModal({ initial, ingredients, categories, onClose, onSave }) {
  const editingId = initial.id || null;
  const [name, setName] = useState(initial.name || "");
  const [category, setCategory] = useState(initial.category || categories[0]?.id || "");
  const [price, setPrice] = useState(initial.price ?? "");
  const [recipe, setRecipe] = useState(initial.recipe || []);

  const addRow = () => {
    if (ingredients.length === 0) return;
    setRecipe([...recipe, { ingredientId: ingredients[0].id, amount: 1 }]);
  };
  const updateRow = (idx, patch) => setRecipe(recipe.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRow = (idx) => setRecipe(recipe.filter((_, i) => i !== idx));

  const cost = recipe.reduce((s, r) => {
    const ing = ingredients.find((i) => i.id === r.ingredientId);
    return s + (ing ? ing.cost * (parseFloat(r.amount) || 0) : 0);
  }, 0);

  const submit = () => {
    if (!name.trim() || price === "" || isNaN(parseFloat(price)) || !category) return;
    onSave(
      { name: name.trim(), category, price: parseFloat(price), recipe: recipe.map((r) => ({ ...r, amount: parseFloat(r.amount) || 0 })) },
      editingId
    );
  };

  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-4" style={{ fontWeight: 600 }}>{editingId ? "Edit product" : "New product"}</h3>
        <div className="space-y-3">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="e.g. Caramel Macchiato" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              {categories.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Add a category first.</p>
              ) : (
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Field>
            <Field label="Price"><input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="0.00" /></Field>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Recipe (per serving)</label>
              <button onClick={addRow} className="text-xs flex items-center gap-1" style={{ color: "var(--primary-dark)" }}><Plus size={12} /> Add ingredient</button>
            </div>
            {ingredients.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Add ingredients in Inventory first.</p>
            ) : recipe.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>No ingredients linked yet.</p>
            ) : (
              <div className="space-y-2">
                {recipe.map((r, idx) => {
                  const ing = ingredients.find((i) => i.id === r.ingredientId);
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <select value={r.ingredientId} onChange={(e) => updateRow(idx, { ingredientId: e.target.value })} className="flex-1 border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--line)" }}>
                        {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                      <input type="number" step="0.1" value={r.amount} onChange={(e) => updateRow(idx, { amount: e.target.value })} className="w-20 border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--line)" }} />
                      <span className="text-xs w-6" style={{ color: "var(--ink-soft)" }}>{ing?.unit}</span>
                      <button onClick={() => removeRow(idx)}><X size={13} color="var(--ink-soft)" /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mono-font text-xs flex justify-between rounded-lg px-3 py-2" style={{ background: "var(--bg)" }}>
            <span style={{ color: "var(--ink-soft)" }}>Est. cost</span>
            <span>{money(cost)} {price !== "" && !isNaN(parseFloat(price)) && <span style={{ color: "var(--ink-soft)" }}>· margin {money(parseFloat(price) - cost)}</span>}</span>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={submit} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--primary)", color: "#fff" }}>Save product</button>
        </div>
      </div>
    </ModalWrap>
  );
}

// ============== Inventory ==============

const INVENTORY_SORTS = [
  { id: "default", label: "Default" },
  { id: "stock", label: "Lowest stock first" },
  { id: "expiry", label: "Closest expiry first" },
];

function InventoryView({ ingredients, products, openNew, openEdit, deleteIngredient, restockId, setRestockId, restockVal, setRestockVal, applyRestock, wasteLogs, openWasteModal }) {
  const [sortBy, setSortBy] = useState("default");
  const [showWaste, setShowWaste] = useState(false);

  // For each ingredient, figure out which products use it and how many more
  // servings of each are still makeable from the ingredient's current stock
  // alone (other ingredients in that recipe might run out sooner — this is
  // just this one ingredient's ceiling).
  const servingsByIngredient = useMemo(() => {
    const map = {};
    for (const ing of ingredients) map[ing.id] = [];
    for (const p of products || []) {
      for (const line of p.recipe || []) {
        const list = map[line.ingredientId];
        if (!list) continue;
        const ing = ingredients.find((i) => i.id === line.ingredientId);
        if (!ing || !line.amount) continue;
        list.push({ productId: p.id, productName: p.name, servings: Math.floor(ing.stock / line.amount) });
      }
    }
    return map;
  }, [ingredients, products]);

  const sortedIngredients = useMemo(() => {
    if (sortBy === "stock") {
      // Lowest stock relative to its own low-stock threshold first (most
      // urgent to restock), so items without a threshold set don't drown out
      // ones that are genuinely close to running out.
      return ingredients.slice().sort((a, b) => {
        const ra = a.low > 0 ? a.stock / a.low : Infinity;
        const rb = b.low > 0 ? b.stock / b.low : Infinity;
        return ra - rb || a.stock - b.stock;
      });
    }
    if (sortBy === "expiry") {
      // Items with an expiry date, soonest first; items without one sink to the bottom.
      return ingredients.slice().sort((a, b) => {
        if (a.expiryDate && b.expiryDate) return a.expiryDate.localeCompare(b.expiryDate);
        if (a.expiryDate) return -1;
        if (b.expiryDate) return 1;
        return 0;
      });
    }
    return ingredients;
  }, [ingredients, sortBy]);

  return (
    <div>
      <SectionTitle
        action={
          <div className="flex items-center gap-2">
            <button onClick={openWasteModal} className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <Trash2 size={14} /> Log waste
            </button>
            <button onClick={openNew} className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg" style={{ background: "var(--primary)", color: "#fff" }}>
              <Plus size={14} /> Add ingredient
            </button>
          </div>
        }
      >
        Stock on hand
      </SectionTitle>
      {ingredients.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs" style={{ color: "var(--ink-soft)" }}>Sort by</span>
          <div className="flex rounded-full border p-0.5" style={{ borderColor: "var(--line)" }}>
            {INVENTORY_SORTS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSortBy(s.id)}
                className="text-xs px-2.5 py-1 rounded-full"
                style={{ background: sortBy === s.id ? "var(--primary)" : "transparent", color: sortBy === s.id ? "#fff" : "var(--ink-soft)" }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {ingredients.length === 0 ? (
        <EmptyState text="No ingredients yet. Add coffee, milk, syrups, or anything you track by weight or volume." />
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="grid grid-cols-[1fr_90px_110px_110px_80px] gap-2 px-3.5 py-2 text-xs font-medium" style={{ color: "var(--ink-soft)", borderBottom: "1px solid var(--line)" }}>
            <span>Ingredient</span><span>Unit</span><span>Stock</span><span>Low at</span><span></span>
          </div>
          {sortedIngredients.map((i) => {
            const isLow = i.low > 0 && i.stock <= i.low;
            const daysToExpiry = i.expiryDate
              ? Math.ceil((new Date(i.expiryDate + "T00:00:00").getTime() - Date.now()) / 86400000)
              : null;
            const isExpired = daysToExpiry !== null && daysToExpiry < 0;
            const isExpiringSoon = daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= 3;
            const servings = servingsByIngredient[i.id] || [];
            return (
              <div key={i.id} className="grid grid-cols-[1fr_90px_110px_110px_80px] gap-2 px-3.5 py-2.5 items-center text-sm mono-font" style={{ borderBottom: "1px solid var(--line)", background: isExpired ? "#F3E3DC" : (isLow || isExpiringSoon) ? "#FBF1EC" : "transparent" }}>
                <div className="min-w-0" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  <span className="truncate block">
                    {i.name}
                    {isLow && <AlertTriangle size={11} color="var(--alert)" className="inline ml-1.5 -mt-0.5" />}
                    {(isExpired || isExpiringSoon) && (
                      <span className="text-[10px] ml-1.5 px-1.5 py-0.5 rounded-full" style={{ background: isExpired ? "var(--alert)" : "#E7C9A8", color: isExpired ? "#fff" : "#6B4A22" }}>
                        {isExpired ? "Expired" : daysToExpiry === 0 ? "Expires today" : `Expires in ${daysToExpiry}d`}
                      </span>
                    )}
                  </span>
                  {servings.length > 0 && (
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                      {servings.map((s) => (
                        <span key={s.productId} className="text-[10.5px]" style={{ color: s.servings <= 0 ? "var(--alert)" : "var(--ink-soft)" }}>
                          {s.productName}: <strong className="font-semibold">{s.servings}</strong> left
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span style={{ color: "var(--ink-soft)" }}>{i.unit}</span>
                {restockId === i.id ? (
                  <div className="flex items-center gap-1">
                    <input autoFocus type="number" value={restockVal} onChange={(e) => setRestockVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyRestock(i.id)} className="w-16 border rounded px-1.5 py-1 text-xs" style={{ borderColor: "var(--line)" }} placeholder="+amt" />
                    <button onClick={() => applyRestock(i.id)}><Check size={13} color="var(--primary-dark)" /></button>
                  </div>
                ) : (
                  <span style={{ color: isLow ? "var(--alert)" : "var(--ink)" }}>{i.stock}</span>
                )}
                <span style={{ color: "var(--ink-soft)" }}>{i.low}</span>
                <div className="flex items-center gap-1 justify-end">
                  <button onClick={() => setRestockId(restockId === i.id ? null : i.id)} className="text-xs px-1.5 py-1 rounded border" style={{ borderColor: "var(--line)" }}>+stock</button>
                  <button onClick={() => openEdit(i)}><Pencil size={12} color="var(--ink-soft)" /></button>
                  <ConfirmDeleteButton onConfirm={() => deleteIngredient(i.id)} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {wasteLogs && wasteLogs.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowWaste((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium mb-2"
            style={{ color: "var(--ink-soft)" }}
          >
            {showWaste ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Waste log ({wasteLogs.length})
          </button>
          {showWaste && (
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <div className="grid grid-cols-[1fr_90px_100px_110px_90px] gap-2 px-3.5 py-2 text-xs font-medium" style={{ color: "var(--ink-soft)", borderBottom: "1px solid var(--line)" }}>
                <span>Ingredient</span><span>Amount</span><span>Reason</span><span>Logged by</span><span>Cost</span>
              </div>
              {wasteLogs.slice().sort((a, b) => b.timestamp - a.timestamp).map((w) => (
                <div key={w.id} className="grid grid-cols-[1fr_90px_100px_110px_90px] gap-2 px-3.5 py-2 items-center text-sm mono-font" style={{ borderBottom: "1px solid var(--line)" }}>
                  <span className="truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
                    {w.ingredientName}
                    {w.productName && (
                      <span className="block text-[10px]" style={{ color: "var(--primary)", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                        for {w.productQty}× {w.productName}
                      </span>
                    )}
                    {w.note && <span className="block text-[10px]" style={{ color: "var(--ink-soft)", fontFamily: "'IBM Plex Sans', sans-serif" }}>{w.note}</span>}
                  </span>
                  <span>{w.amount}{w.unit}</span>
                  <span style={{ color: "var(--ink-soft)" }}>{w.reason}</span>
                  <span className="truncate" style={{ color: "var(--ink-soft)", fontFamily: "'IBM Plex Sans', sans-serif" }}>{w.loggedByName}</span>
                  <span style={{ color: "var(--alert)" }}>{money(w.cost)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IngredientModal({ initial, onClose, onSave }) {
  const editingId = initial.id || null;
  const [name, setName] = useState(initial.name || "");
  const [unit, setUnit] = useState(initial.unit || "g");
  const [stock, setStock] = useState(initial.stock ?? "");
  const [low, setLow] = useState(initial.low ?? "");
  const [expiryDate, setExpiryDate] = useState(initial.expiryDate || "");
  const [costMode, setCostMode] = useState("direct"); // 'direct' | 'purchase'
  const [directCost, setDirectCost] = useState(initial.cost ?? "");
  const [purchaseQty, setPurchaseQty] = useState("");
  const [purchaseCost, setPurchaseCost] = useState("");

  const purchaseQtyNum = parseFloat(purchaseQty) || 0;
  const purchaseCostNum = parseFloat(purchaseCost) || 0;
  const priorStock = parseFloat(stock) || 0;
  const priorCost = parseFloat(initial.cost) || 0;
  // "Calculate from what I paid" represents an actual purchase/delivery: it adds
  // the purchased quantity to on-hand stock and recomputes a weighted-average cost,
  // rather than only updating the cost-per-unit while leaving stock untouched.
  const willAddStock = costMode === "purchase" && purchaseQtyNum > 0;
  const newStockAfterPurchase = willAddStock ? +(priorStock + purchaseQtyNum).toFixed(4) : priorStock;
  const computedCost =
    costMode === "purchase"
      ? (willAddStock
          ? (priorStock * priorCost + purchaseCostNum) / newStockAfterPurchase
          : (purchaseQtyNum > 0 ? purchaseCostNum / purchaseQtyNum : 0))
      : (parseFloat(directCost) || 0);

  const submit = () => {
    if (!name.trim() || stock === "" || isNaN(parseFloat(stock))) return;
    const finalStock = willAddStock ? newStockAfterPurchase : parseFloat(stock);
    onSave(
      { name: name.trim(), unit, stock: +finalStock.toFixed(4), low: parseFloat(low) || 0, cost: +computedCost.toFixed(4), expiryDate: expiryDate || null },
      editingId
    );
  };

  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-4" style={{ fontWeight: 600 }}>{editingId ? "Edit ingredient" : "New ingredient"}</h3>
        <div className="space-y-3">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="e.g. Coffee Syrup, Egg" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tracked in">
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                {UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </Field>
            <Field label={`Current stock (${unitLabel(unit)})`}><input type="number" step="0.1" value={stock} onChange={(e) => setStock(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="0" /></Field>
          </div>
          <Field label="Expiry / best-by date (optional)">
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} />
          </Field>
          <p className="text-xs -mt-1.5" style={{ color: "var(--ink-soft)" }}>

            Use grams/ml for things you portion out (syrup, milk, beans), and pieces or servings for whole items you count (eggs, croissants, rice servings).
          </p>
          <Field label={`Low-stock alert at (${unitLabel(unit)})`}><input type="number" step="0.1" value={low} onChange={(e) => setLow(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="0" /></Field>

          <div className="pt-1">
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--ink-soft)" }}>Costing</label>
            <div className="flex rounded-lg border p-0.5 mb-2.5 text-xs" style={{ borderColor: "var(--line)" }}>
              <button type="button" onClick={() => setCostMode("direct")} className="flex-1 py-1.5 rounded-md" style={{ background: costMode === "direct" ? "var(--primary)" : "transparent", color: costMode === "direct" ? "#fff" : "var(--ink-soft)" }}>
                I know the cost per {unitLabel(unit)}
              </button>
              <button type="button" onClick={() => setCostMode("purchase")} className="flex-1 py-1.5 rounded-md" style={{ background: costMode === "purchase" ? "var(--primary)" : "transparent", color: costMode === "purchase" ? "#fff" : "var(--ink-soft)" }}>
                Calculate from what I paid
              </button>
            </div>

            {costMode === "direct" ? (
              <Field label={`Cost per ${unitLabel(unit)}`}>
                <input type="number" step="0.0001" value={directCost} onChange={(e) => setDirectCost(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="0.00" />
              </Field>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Quantity bought (${unitLabel(unit)})`}>
                  <input type="number" step="0.1" value={purchaseQty} onChange={(e) => setPurchaseQty(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="e.g. 1000" />
                </Field>
                <Field label="Total amount paid">
                  <input type="number" step="0.01" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="e.g. 900" />
                </Field>
              </div>
            )}
            {costMode === "purchase" && (
              <p className="text-xs mt-2" style={{ color: willAddStock ? "var(--primary-dark)" : "var(--ink-soft)" }}>
                {willAddStock
                  ? `This records a purchase: +${purchaseQtyNum}${unitLabel(unit)} added to stock → new stock ${newStockAfterPurchase}${unitLabel(unit)}.`
                  : "Enter a quantity bought to add it to your on-hand stock."}
              </p>
            )}
            <div className="mono-font text-xs flex justify-between rounded-lg px-3 py-2 mt-2.5" style={{ background: "var(--bg)" }}>
              <span style={{ color: "var(--ink-soft)" }}>≈ cost per {unitLabel(unit)}</span>
              <span>{money(computedCost)}</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={submit} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--primary)", color: "#fff" }}>Save ingredient</button>
        </div>
      </div>
    </ModalWrap>
  );
}

// ============== Waste / spoilage ==============

function WasteModal({ ingredients, products, onClose, onSaveIngredient, onSaveProduct }) {
  const [mode, setMode] = useState("ingredient"); // 'ingredient' | 'product'
  const [ingredientId, setIngredientId] = useState(ingredients[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [productId, setProductId] = useState(products?.[0]?.id || "");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState(WASTE_REASONS[0]);
  const [note, setNote] = useState("");

  const ing = ingredients.find((i) => i.id === ingredientId) || null;
  const amt = parseFloat(amount) || 0;
  const ingredientCost = ing ? amt * ing.cost : 0;
  const ingredientValid = !!ing && amt > 0;

  const product = (products || []).find((p) => p.id === productId) || null;
  const q = parseFloat(qty) || 0;
  // Preview of exactly what a product waste entry will deduct, so the
  // cashier can see the ingredient breakdown before confirming.
  const productLines = useMemo(() => {
    if (!product) return [];
    return product.recipe.map((r) => {
      const i = ingredients.find((x) => x.id === r.ingredientId);
      const lineAmt = r.amount * q;
      return {
        key: r.ingredientId,
        name: i ? i.name : "Deleted ingredient",
        unit: i ? unitLabel(i.unit) : "",
        amount: lineAmt,
        cost: i ? i.cost * lineAmt : 0,
      };
    });
  }, [product, ingredients, q]);
  const productCost = productLines.reduce((s, l) => s + l.cost, 0);
  const productValid = !!product && q > 0 && product.recipe && product.recipe.length > 0;

  const valid = mode === "ingredient" ? ingredientValid : productValid;

  const submit = () => {
    if (mode === "ingredient") {
      if (!ingredientValid) return;
      onSaveIngredient(ingredientId, amount, reason, note);
    } else {
      if (!productValid) return;
      onSaveProduct(productId, qty, reason, note);
    }
  };

  return (
    <ModalWrap onClose={onClose}>
      <div className="px-5 py-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Log waste</h3>
        <p className="text-xs mb-4" style={{ color: "var(--ink-soft)" }}>
          For stock lost before it became a sale — spoilage, breakage, staff meals. This deducts from stock right away.
        </p>

        <div className="flex rounded-full border p-0.5 mb-4 text-xs" style={{ borderColor: "var(--line)" }}>
          <button
            onClick={() => setMode("ingredient")}
            className="flex-1 py-1.5 rounded-full font-medium"
            style={{ background: mode === "ingredient" ? "var(--primary)" : "transparent", color: mode === "ingredient" ? "#fff" : "var(--ink-soft)" }}
          >
            Raw ingredient
          </button>
          <button
            onClick={() => setMode("product")}
            className="flex-1 py-1.5 rounded-full font-medium"
            style={{ background: mode === "product" ? "var(--primary)" : "transparent", color: mode === "product" ? "#fff" : "var(--ink-soft)" }}
          >
            Finished product
          </button>
        </div>

        {mode === "ingredient" ? (
          <div className="space-y-3">
            <Field label="Ingredient">
              {ingredients.length > 0 ? (
                <select value={ingredientId} onChange={(e) => setIngredientId(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                  {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              ) : (
                <p className="text-xs" style={{ color: "var(--alert)" }}>No ingredients yet — add one first.</p>
              )}
            </Field>
            <Field label={`Amount lost${ing ? ` (${unitLabel(ing.unit)})` : ""}`}>
              <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="0" />
            </Field>
            {ing && amt > 0 && (
              <div className="mono-font text-xs flex justify-between rounded-lg px-3 py-2" style={{ background: "var(--bg)" }}>
                <span style={{ color: "var(--ink-soft)" }}>Cost of this waste</span>
                <span style={{ color: "var(--alert)" }}>{money(ingredientCost)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Product">
              {products && products.length > 0 ? (
                <select value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : (
                <p className="text-xs" style={{ color: "var(--alert)" }}>No products yet — add one first.</p>
              )}
            </Field>
            <Field label="Quantity">
              <input type="number" step="1" min="0" value={qty} onChange={(e) => setQty(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }} placeholder="1" />
            </Field>
            {product && (!product.recipe || product.recipe.length === 0) && (
              <p className="text-xs" style={{ color: "var(--alert)" }}>This product has no recipe set, so nothing can be deducted.</p>
            )}
            {productLines.length > 0 && q > 0 && (
              <div className="rounded-lg px-3 py-2 space-y-1" style={{ background: "var(--bg)" }}>
                <div className="text-xs font-medium mb-1" style={{ color: "var(--ink-soft)" }}>Will deduct</div>
                {productLines.map((l) => (
                  <div key={l.key} className="mono-font text-xs flex justify-between">
                    <span>{l.name}</span>
                    <span style={{ color: "var(--ink-soft)" }}>{+l.amount.toFixed(2)}{l.unit}</span>
                  </div>
                ))}
                <div className="mono-font text-xs flex justify-between pt-1 mt-1" style={{ borderTop: "1px solid var(--line)" }}>
                  <span style={{ color: "var(--ink-soft)" }}>Cost of this waste</span>
                  <span style={{ color: "var(--alert)" }}>{money(productCost)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 mt-3">
          <Field label="Reason">
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" style={{ borderColor: "var(--line)" }}>
              {WASTE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Note (optional)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm resize-none" style={{ borderColor: "var(--line)" }} placeholder="Any details…" />
          </Field>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={submit} disabled={!valid} className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-50" style={{ background: "var(--alert)", color: "#fff" }}>Log waste</button>
        </div>
      </div>
    </ModalWrap>
  );
}

// ============== Shift (X/Z report) ==============

function ShiftView({ activeShift, shifts, currentEmployee, cashSoFar, onlineSoFar, openShift, openCloseModal }) {
  const [openingFloat, setOpeningFloat] = useState("");
  const pastShifts = useMemo(
    () => shifts.filter((s) => s.closedAt).slice().sort((a, b) => b.closedAt - a.closedAt),
    [shifts]
  );

  return (
    <div>
      <SectionTitle>Shift</SectionTitle>

      {!activeShift ? (
        <div className="rounded-xl border p-5" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <p className="text-sm mb-3" style={{ color: "var(--ink-soft)" }}>
            No shift is open. Start one with the cash you're putting in the drawer, and it'll track cash sales against it until you close out.
          </p>
          <div className="flex items-center gap-2 max-w-xs">
            <input
              type="number"
              min="0"
              step="0.01"
              value={openingFloat}
              onChange={(e) => setOpeningFloat(e.target.value)}
              placeholder="Opening cash"
              className="flex-1 border rounded-lg px-3 py-2 text-sm mono-font"
              style={{ borderColor: "var(--line)" }}
            />
            <button
              onClick={() => { openShift(openingFloat); setOpeningFloat(""); }}
              disabled={!currentEmployee}
              className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Start shift
            </button>
          </div>
          {!currentEmployee && <p className="text-xs mt-2" style={{ color: "var(--alert)" }}>Select an employee first.</p>}
        </div>
      ) : (
        <div className="rounded-xl border p-5" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <span className="w-2 h-2 rounded-full" style={{ background: "var(--primary)" }} />
              Shift open — X report
            </div>
            <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
              Opened {new Date(activeShift.openedAt).toLocaleString()} by {activeShift.openedByName}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mono-font text-sm mb-4">
            <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--ink-soft)" }}>Opening cash</div>
              <div className="text-base font-semibold">{money(activeShift.openingFloat)}</div>
            </div>
            <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--ink-soft)" }}>Cash sales so far</div>
              <div className="text-base font-semibold">{money(cashSoFar)}</div>
            </div>
            <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--ink-soft)" }}>Online received</div>
              <div className="text-base font-semibold">{money(onlineSoFar)}</div>
            </div>
            <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--bg)" }}>
              <div className="text-xs mb-0.5" style={{ color: "var(--ink-soft)" }}>Expected cash (w/ opening)</div>
              <div className="text-base font-semibold">{money(activeShift.openingFloat + cashSoFar)}</div>
            </div>
          </div>
          <button onClick={openCloseModal} className="w-full py-2 rounded-lg text-sm font-medium" style={{ background: "var(--alert)", color: "#fff" }}>
            Close shift &amp; count drawer
          </button>
        </div>
      )}

      {pastShifts.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium mb-2" style={{ color: "var(--ink-soft)" }}>Past shifts (Z reports)</h3>
          <div className="space-y-2">
            {pastShifts.map((s) => (
              <div key={s.id} className="rounded-xl border p-3.5" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-sm font-medium">
                    {new Date(s.closedAt).toLocaleDateString()}{" "}
                    <span className="text-xs font-normal" style={{ color: "var(--ink-soft)" }}>
                      {new Date(s.closedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                  <span className="mono-font text-xs font-semibold" style={{ color: s.variance === 0 ? "var(--primary-dark)" : "var(--alert)" }}>
                    {s.variance === 0 ? "Matched" : s.variance > 0 ? `+${money(s.variance)} over` : `-${money(Math.abs(s.variance))} short`}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div style={{ color: "var(--ink-soft)" }}>
                    Opened by <span style={{ color: "var(--ink)", fontWeight: 600 }}>{s.openedByName}</span>
                  </div>
                  <div style={{ color: "var(--ink-soft)" }}>
                    Closed by <span style={{ color: "var(--ink)", fontWeight: 600 }}>{s.closedByName}</span>
                  </div>
                  <div className="mono-font" style={{ color: "var(--ink-soft)" }}>
                    Opening cash <span style={{ color: "var(--ink)" }}>{money(s.openingFloat)}</span>
                  </div>
                  <div className="mono-font" style={{ color: "var(--ink-soft)" }}>
                    Online received <span style={{ color: "var(--ink)" }}>{money(s.onlineCollected ?? 0)}</span>
                  </div>
                  <div className="mono-font" style={{ color: "var(--ink-soft)" }}>
                    Expected cash <span style={{ color: "var(--ink)" }}>{money(s.expectedCash)}</span>
                  </div>
                  <div className="mono-font" style={{ color: "var(--ink-soft)" }}>
                    Counted cash <span style={{ color: "var(--ink)" }}>{money(s.countedCash)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShiftCloseModal({ shift, expectedCash, cashCollected, onlineCollected, currentEmployee, onClose, onConfirm }) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const countedNum = parseFloat(counted);
  const valid = !isNaN(countedNum) && countedNum >= 0;
  const variance = valid ? +(countedNum - expectedCash).toFixed(2) : null;

  return (
    <ModalWrap onClose={onClose}>
      <div className="p-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Close shift</h3>
        <p className="text-xs mb-3" style={{ color: "var(--ink-soft)" }}>
          Opened {new Date(shift.openedAt).toLocaleString()} · opening cash {money(shift.openingFloat)}
        </p>
        <div className="rounded-lg px-3 py-2 mb-3 text-xs flex items-center justify-between" style={{ background: "var(--bg)" }}>
          <span>
            <span style={{ color: "var(--ink-soft)" }}>Opened by</span>{" "}
            <span style={{ fontWeight: 600 }}>{shift.openedByName}</span>
          </span>
          <span>
            <span style={{ color: "var(--ink-soft)" }}>Closing as</span>{" "}
            <span style={{ fontWeight: 600 }}>{currentEmployee?.name || "Unassigned"}</span>
          </span>
        </div>
        {currentEmployee?.name && currentEmployee.name !== shift.openedByName && (
          <p className="text-xs mb-3" style={{ color: "var(--alert)" }}>
            Note: a different employee is closing this shift than the one who opened it.
          </p>
        )}
        <div className="rounded-lg px-3 py-2.5 mb-4 text-xs space-y-1.5 mono-font" style={{ background: "var(--bg)" }}>
          <div className="flex justify-between">
            <span style={{ color: "var(--ink-soft)" }}>Opening cash</span>
            <span>{money(shift.openingFloat)}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: "var(--ink-soft)" }}>Cash sales this shift</span>
            <span>{money(cashCollected)}</span>
          </div>
          <div className="flex justify-between pt-1.5" style={{ borderTop: "1px dashed var(--line)" }}>
            <span style={{ color: "var(--ink-soft)" }}>Expected cash (incl. opening)</span>
            <span className="font-semibold">{money(expectedCash)}</span>
          </div>
          <div className="flex justify-between pt-1.5" style={{ borderTop: "1px dashed var(--line)" }}>
            <span style={{ color: "var(--ink-soft)" }}>Total online received</span>
            <span className="font-semibold">{money(onlineCollected)}</span>
          </div>
        </div>
        <Field label="Cash counted in drawer">
          <input
            autoFocus
            type="number"
            min="0"
            step="0.01"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm mono-font"
            style={{ borderColor: "var(--line)" }}
            placeholder="0.00"
          />
        </Field>
        {variance !== null && (
          <p className="text-xs mt-1.5" style={{ color: variance === 0 ? "var(--primary-dark)" : "var(--alert)" }}>
            {variance === 0 ? "Matches exactly." : variance > 0 ? `Over by ${money(variance)}.` : `Short by ${money(Math.abs(variance))}.`}
          </p>
        )}
        <Field label="Note (optional)">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm resize-none mt-1.5" style={{ borderColor: "var(--line)" }} placeholder="Any details about the count…" />
        </Field>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button
            onClick={() => onConfirm(counted, note)}
            disabled={!valid}
            className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--primary)", color: "#fff" }}
          >
            Close shift
          </button>
        </div>
      </div>
    </ModalWrap>
  );
}

// Shown whenever the employee on the register is about to change while a
// shift is open. Combines a close-out count for the outgoing employee with
// an opening float for the incoming one, so the switch itself produces a
// clean handoff record instead of one shift silently spanning two people.
function EmployeeHandoffModal({ shift, expectedCash, cashCollected, onlineCollected, outgoingEmployee, incomingEmployee, onClose, onConfirm }) {
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [openingFloat, setOpeningFloat] = useState("");
  const countedNum = parseFloat(counted);
  const countedValid = !isNaN(countedNum) && countedNum >= 0;
  const variance = countedValid ? +(countedNum - expectedCash).toFixed(2) : null;
  const floatNum = parseFloat(openingFloat);
  const floatValid = !isNaN(floatNum) && floatNum >= 0;

  // Once the drawer's counted, default the incoming float to that same
  // amount — usually the drawer just stays put and the cash carries over.
  // Cashier can still edit it (e.g. taking bills out for a bank drop).
  useEffect(() => {
    if (countedValid && openingFloat === "") setOpeningFloat(counted);
  }, [countedValid, counted]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ModalWrap onClose={onClose}>
      <div className="p-5">
        <h3 className="display-font text-lg mb-1" style={{ fontWeight: 600 }}>Hand off shift</h3>
        <p className="text-xs mb-3" style={{ color: "var(--ink-soft)" }}>
          Switching from <span style={{ fontWeight: 600 }}>{outgoingEmployee?.name || "Unassigned"}</span> to{" "}
          <span style={{ fontWeight: 600 }}>{incomingEmployee.name}</span>. Count the drawer to close{" "}
          {outgoingEmployee?.name || "their"}'s shift, then set what {incomingEmployee.name} is starting with.
        </p>
        <div className="rounded-lg px-3 py-2.5 mb-4 text-xs space-y-1.5 mono-font" style={{ background: "var(--bg)" }}>
          <div className="flex justify-between">
            <span style={{ color: "var(--ink-soft)" }}>Opening cash</span>
            <span>{money(shift.openingFloat)}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: "var(--ink-soft)" }}>Cash sales this shift</span>
            <span>{money(cashCollected)}</span>
          </div>
          <div className="flex justify-between pt-1.5" style={{ borderTop: "1px dashed var(--line)" }}>
            <span style={{ color: "var(--ink-soft)" }}>Expected cash (incl. opening)</span>
            <span className="font-semibold">{money(expectedCash)}</span>
          </div>
          <div className="flex justify-between pt-1.5" style={{ borderTop: "1px dashed var(--line)" }}>
            <span style={{ color: "var(--ink-soft)" }}>Total online received</span>
            <span className="font-semibold">{money(onlineCollected)}</span>
          </div>
        </div>
        <Field label={`Cash counted in drawer (${outgoingEmployee?.name || "outgoing"}'s close-out)`}>
          <input
            autoFocus
            type="number"
            min="0"
            step="0.01"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm mono-font"
            style={{ borderColor: "var(--line)" }}
            placeholder="0.00"
          />
        </Field>
        {variance !== null && (
          <p className="text-xs mt-1.5" style={{ color: variance === 0 ? "var(--primary-dark)" : "var(--alert)" }}>
            {variance === 0 ? "Matches exactly." : variance > 0 ? `Over by ${money(variance)}.` : `Short by ${money(Math.abs(variance))}.`}
          </p>
        )}
        <div className="mt-3">
          <Field label="Note on close-out (optional)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm resize-none mt-1.5" style={{ borderColor: "var(--line)" }} placeholder="Any details about the count…" />
          </Field>
        </div>
        <div className="mt-4 pt-4" style={{ borderTop: "1px solid var(--line)" }}>
          <Field label={`Opening float for ${incomingEmployee.name}`}>
            <input
              type="number"
              min="0"
              step="0.01"
              value={openingFloat}
              onChange={(e) => setOpeningFloat(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm mono-font"
              style={{ borderColor: "var(--line)" }}
              placeholder="0.00"
            />
          </Field>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button
            onClick={() => onConfirm(counted, note, openingFloat)}
            disabled={!countedValid || !floatValid}
            className="flex-1 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--primary)", color: "#fff" }}
          >
            Confirm handoff
          </button>
        </div>
      </div>
    </ModalWrap>
  );
}

// ============== Reports ==============

function ReportsView({
  reportMode, setReportMode, reportDay, setReportDay, reportMonth, setReportMonth,
  reportRangeStart, setReportRangeStart, reportRangeEnd, setReportRangeEnd,
  stats, trendData, lowStock, sales, voidedSales, periodLabel,
}) {
  const presetRange = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setReportRangeStart(dateKey(start.getTime()));
    setReportRangeEnd(dateKey(end.getTime()));
    setReportMode("range");
  };
  const ordersByRecent = useMemo(() => sales.slice().sort((a, b) => b.timestamp - a.timestamp), [sales]);
  const handlePrint = () => window.print();

  // CSV export of orders in the current period (active + voided), one row per
  // order. Downloads directly — no server round trip needed.
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const handleExportCSV = () => {
    const rows = sales.slice().concat(voidedSales || []).sort((a, b) => b.timestamp - a.timestamp);
    const header = ["Order #", "Date/time", "Employee", "Items", "Payment", "Subtotal", "Discount", "Total", "Cost", "Voided", "Void reason", "Approved by"];
    const lines = [header.map(csvCell).join(",")];
    rows.forEach((s) => {
      lines.push([
        s.orderNo,
        new Date(s.timestamp).toLocaleString(),
        s.employeeName || "",
        s.items.map((i) => `${i.qty}x ${i.name}`).join("; "),
        s.paymentMethod === "split" && s.payments
          ? `split (cash ${money(saleCashAmount(s))} / online ${money(saleOnlineAmount(s))})`
          : s.paymentMethod,
        s.subtotal.toFixed(2),
        (s.discountAmount || 0).toFixed(2),
        s.total.toFixed(2),
        s.totalCost.toFixed(2),
        s.voided ? "yes" : "no",
        s.voided ? (s.voidReason || "") : "",
        s.voided ? (s.approvedByName || "") : "",
      ].map(csvCell).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orders_${periodLabel.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4 mt-2 no-print">
        <div className="flex rounded-full border p-0.5" style={{ borderColor: "var(--line)" }}>
          {["day", "month", "range"].map((m) => (
            <button key={m} onClick={() => setReportMode(m)} className="text-xs px-3 py-1 rounded-full capitalize" style={{ background: reportMode === m ? "var(--primary)" : "transparent", color: reportMode === m ? "#fff" : "var(--ink-soft)" }}>
              {m === "range" ? "Custom range" : `Per ${m}`}
            </button>
          ))}
        </div>
        {reportMode === "day" && (
          <input type="date" value={reportDay} onChange={(e) => setReportDay(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
        )}
        {reportMode === "month" && (
          <input type="month" value={reportMonth} onChange={(e) => setReportMonth(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
        )}
        {reportMode === "range" && (
          <div className="flex items-center gap-1.5">
            <input type="date" value={reportRangeStart} onChange={(e) => setReportRangeStart(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
            <span className="text-xs" style={{ color: "var(--ink-soft)" }}>to</span>
            <input type="date" value={reportRangeEnd} onChange={(e) => setReportRangeEnd(e.target.value)} className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: "var(--line)" }} />
          </div>
        )}
        <div className="flex items-center gap-1.5 sm:ml-auto">
          {[
            { label: "7d", fn: () => presetRange(7) },
            { label: "30d", fn: () => presetRange(30) },
            { label: "90d", fn: () => presetRange(90) },
          ].map((p) => (
            <button key={p.label} onClick={p.fn} className="text-xs px-2.5 py-1 rounded-full border" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              {p.label}
            </button>
          ))}
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium border"
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            title="Downloads a CSV of this period's orders"
          >
            Export CSV
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium"
            style={{ background: "var(--primary)", color: "#fff" }}
            title="Opens the print dialog — choose 'Save as PDF' as the destination"
          >
            <ReceiptIcon size={13} /> Download PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3 no-print">
        <Stat label="Orders" value={stats.orders} />
        <Stat label="Revenue" value={money(stats.revenue)} accent />
        <Stat label="Est. profit" value={money(stats.profit)} />
        <Stat label="Items sold" value={stats.itemsSold} />
      </div>
      <div className="grid grid-cols-3 gap-3 mb-6 no-print">
        <Stat label="Cash sales" value={money(stats.cashRevenue)} small />
        <Stat label="Online sales" value={money(stats.onlineRevenue)} small />
        <Stat label="Discounts given" value={money(stats.discountsGiven)} small />
      </div>

      {lowStock.length > 0 && (
        <div className="rounded-xl p-3.5 mb-6 text-sm no-print" style={{ background: "#FBF1EC" }}>
          <div className="flex items-center gap-1.5 font-medium mb-1.5" style={{ color: "var(--alert)" }}>
            <AlertTriangle size={14} /> Low stock
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mono-font text-xs" style={{ color: "var(--ink-soft)" }}>
            {lowStock.map((i) => <span key={i.id}>{i.name}: {i.stock}{i.unit}</span>)}
          </div>
        </div>
      )}

      {stats.voidedOrders > 0 && (
        <div className="rounded-xl p-3.5 mb-6 text-sm no-print" style={{ background: "var(--bg)" }}>
          <div className="flex items-center gap-1.5 font-medium mb-1.5" style={{ color: "var(--ink-soft)" }}>
            <Ban size={14} /> Voided this period — not counted in totals above
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mono-font text-xs" style={{ color: "var(--ink-soft)" }}>
            <span>{stats.voidedOrders} order{stats.voidedOrders === 1 ? "" : "s"}</span>
            <span>Revenue lost: {money(stats.voidedRevenue)}</span>
            <span>Cost avoided: {money(stats.voidedCost)}</span>
            <span>Profit forgone: {money(stats.voidedProfit)}</span>
          </div>
        </div>
      )}

      {stats.wasteEntries > 0 && (
        <div className="rounded-xl p-3.5 mb-6 text-sm no-print" style={{ background: "var(--bg)" }}>
          <div className="flex items-center gap-1.5 font-medium mb-1.5" style={{ color: "var(--ink-soft)" }}>
            <Trash2 size={14} /> Waste / spoilage this period — not counted in cost/profit above
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mono-font text-xs" style={{ color: "var(--ink-soft)" }}>
            <span>{stats.wasteEntries} entr{stats.wasteEntries === 1 ? "y" : "ies"}</span>
            <span>Total cost: {money(stats.wasteCost)}</span>
            {stats.wasteByReason.map((r) => (
              <span key={r.reason}>{r.reason}: {money(r.cost)}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 no-print">
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <h3 className="text-sm font-medium mb-3">
            {reportMode === "day" ? "Last 7 days" : reportMode === "month" ? "Last 6 months" : "Selected range"}
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#7A6D5C" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} interval={trendData.length > 14 ? "preserveStartEnd" : 0} />
              <YAxis tick={{ fontSize: 11, fill: "#7A6D5C" }} axisLine={false} tickLine={false} width={36} />
              <Tooltip formatter={(v) => money(v)} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--line)" }} />
              <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                {trendData.map((d, idx) => (
                  <Cell key={idx} fill={(reportMode === "day" ? d.key === reportDay : reportMode === "month" ? d.key === reportMonth : false) ? "var(--accent)" : "var(--primary)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border p-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <h3 className="text-sm font-medium mb-3">Best sellers, this period</h3>
          {stats.best.length === 0 ? (
            <p className="text-sm py-8 text-center" style={{ color: "var(--ink-soft)" }}>No sales in this period yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats.best} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: "#7A6D5C" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#2B2420" }} axisLine={false} tickLine={false} width={110} />
                <Tooltip formatter={(v) => [v, "sold"]} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "var(--line)" }} />
                <Bar dataKey="qty" radius={[0, 4, 4, 0]} fill="var(--primary)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {stats.byEmployee.length > 0 && (
        <div className="rounded-xl border p-4 mt-6 no-print" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <h3 className="text-sm font-medium mb-3">Sales by employee</h3>
          <div className="space-y-1.5">
            {stats.byEmployee.map((e) => (
              <div key={e.name} className="flex items-center justify-between text-sm mono-font px-1">
                <span style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{e.name}</span>
                <span style={{ color: "var(--ink-soft)" }}>{e.orders} order{e.orders === 1 ? "" : "s"}</span>
                <span>{money(e.revenue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 no-print">
        <SectionTitle>Orders this period ({ordersByRecent.length})</SectionTitle>
        {ordersByRecent.length === 0 ? (
          <EmptyState text="No orders in this period." />
        ) : (
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
            {ordersByRecent.map((s) => (
              <div key={s.id} className="px-3.5 py-2.5 text-sm" style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">Order #{s.orderNo}</span>
                  <span className="text-xs" style={{ color: "var(--ink-soft)" }}>{new Date(s.timestamp).toLocaleString()}</span>
                  {s.employeeName && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--bg)", color: "var(--ink-soft)" }}>{s.employeeName}</span>
                  )}
                  <span className="mono-font font-semibold ml-auto">{money(s.total)}</span>
                </div>
                <div className="text-xs mt-1" style={{ color: "var(--ink-soft)" }}>
                  {s.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Printable version — hidden on screen, only shown when printing / saving as PDF */}
      <PrintableReport periodLabel={periodLabel} stats={stats} lowStock={lowStock} sales={ordersByRecent} />
    </div>
  );
}

function PrintableReport({ periodLabel, stats, lowStock, sales }) {
  return (
    <div className="print-only" style={{ color: "#2B2420", fontFamily: "'IBM Plex Sans', sans-serif", padding: "12px 4px" }}>
      <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, marginBottom: 2 }}>The Counter — Report</h1>
      <p style={{ fontSize: 12, color: "#7A6D5C", marginBottom: 16 }}>
        Period: {periodLabel} · Generated {new Date().toLocaleString()}
      </p>

      <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Summary</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
        <tbody>
          {[
            ["Orders", stats.orders],
            ["Revenue", money(stats.revenue)],
            ["Estimated cost", money(stats.cost)],
            ["Estimated profit", money(stats.profit)],
            ["Items sold", stats.itemsSold],
            ["Cash sales", money(stats.cashRevenue)],
            ["Online sales", money(stats.onlineRevenue)],
            ["Discounts given", money(stats.discountsGiven)],
          ].map(([label, val]) => (
            <tr key={label} style={{ borderBottom: "1px solid #E4DCC8" }}>
              <td style={{ padding: "4px 6px 4px 0", color: "#7A6D5C" }}>{label}</td>
              <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 600 }}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {stats.voidedOrders > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Voided (excluded above)</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
            <tbody>
              {[
                ["Voided orders", stats.voidedOrders],
                ["Revenue lost", money(stats.voidedRevenue)],
                ["Cost avoided", money(stats.voidedCost)],
                ["Profit forgone", money(stats.voidedProfit)],
              ].map(([label, val]) => (
                <tr key={label} style={{ borderBottom: "1px solid #E4DCC8" }}>
                  <td style={{ padding: "4px 6px 4px 0", color: "#7A6D5C" }}>{label}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 600 }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {stats.wasteEntries > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Waste / spoilage</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
            <tbody>
              {[
                ["Entries", stats.wasteEntries],
                ["Total cost", money(stats.wasteCost)],
                ...stats.wasteByReason.map((r) => [r.reason, money(r.cost)]),
              ].map(([label, val]) => (
                <tr key={label} style={{ borderBottom: "1px solid #E4DCC8" }}>
                  <td style={{ padding: "4px 6px 4px 0", color: "#7A6D5C" }}>{label}</td>
                  <td style={{ padding: "4px 0", textAlign: "right", fontWeight: 600 }}>{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {stats.best.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Best sellers</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #2B2420" }}>
                <th style={{ textAlign: "left", padding: "4px 6px 4px 0" }}>Item</th>
                <th style={{ textAlign: "right", padding: "4px 6px" }}>Qty sold</th>
                <th style={{ textAlign: "right", padding: "4px 0" }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {stats.best.map((b) => (
                <tr key={b.name} style={{ borderBottom: "1px solid #E4DCC8" }}>
                  <td style={{ padding: "4px 6px 4px 0" }}>{b.name}</td>
                  <td style={{ textAlign: "right", padding: "4px 6px" }}>{b.qty}</td>
                  <td style={{ textAlign: "right", padding: "4px 0" }}>{money(b.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {stats.byEmployee.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Sales by employee</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #2B2420" }}>
                <th style={{ textAlign: "left", padding: "4px 6px 4px 0" }}>Employee</th>
                <th style={{ textAlign: "right", padding: "4px 6px" }}>Orders</th>
                <th style={{ textAlign: "right", padding: "4px 0" }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {stats.byEmployee.map((e) => (
                <tr key={e.name} style={{ borderBottom: "1px solid #E4DCC8" }}>
                  <td style={{ padding: "4px 6px 4px 0" }}>{e.name}</td>
                  <td style={{ textAlign: "right", padding: "4px 6px" }}>{e.orders}</td>
                  <td style={{ textAlign: "right", padding: "4px 0" }}>{money(e.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {lowStock.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>Low stock</h2>
          <p style={{ fontSize: 12, marginBottom: 16 }}>
            {lowStock.map((i) => `${i.name}: ${i.stock}${i.unit}`).join("  ·  ")}
          </p>
        </>
      )}

      <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>
        Orders this period ({sales.length})
      </h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #2B2420" }}>
            <th style={{ textAlign: "left", padding: "4px 6px 4px 0" }}>#</th>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>Date/time</th>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>Employee</th>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>Items</th>
            <th style={{ textAlign: "left", padding: "4px 6px" }}>Payment</th>
            <th style={{ textAlign: "right", padding: "4px 0" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id} style={{ borderBottom: "1px solid #E4DCC8" }}>
              <td style={{ padding: "4px 6px 4px 0", verticalAlign: "top" }}>{s.orderNo}{s.voided ? " (voided)" : ""}</td>
              <td style={{ padding: "4px 6px", verticalAlign: "top" }}>{new Date(s.timestamp).toLocaleString()}</td>
              <td style={{ padding: "4px 6px", verticalAlign: "top" }}>{s.employeeName || "—"}</td>
              <td style={{ padding: "4px 6px", verticalAlign: "top" }}>{s.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
              <td style={{ padding: "4px 6px", verticalAlign: "top", textTransform: "capitalize" }}>{s.paymentMethod}</td>
              <td style={{ padding: "4px 0", textAlign: "right", verticalAlign: "top" }}>{money(s.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {sales.some((s) => (s.paymentMethod === "online" || s.paymentMethod === "split") && s.paymentProof) && (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginTop: 20, marginBottom: 6 }}>
            Payment proof photos
          </h2>
          {sales
            .filter((s) => (s.paymentMethod === "online" || s.paymentMethod === "split") && s.paymentProof)
            .map((s) => (
              <div key={s.id} style={{ marginBottom: 14, breakInside: "avoid", pageBreakInside: "avoid" }}>
                <p style={{ fontSize: 11, color: "#7A6D5C", marginBottom: 4 }}>
                  Order #{s.orderNo}{s.voided ? " (voided)" : ""} · {new Date(s.timestamp).toLocaleString()} · {s.employeeName || "—"} · {money(s.total)}
                </p>
                <img
                  src={s.paymentProof}
                  alt={`Payment proof for order #${s.orderNo}`}
                  style={{ maxWidth: 260, maxHeight: 260, borderRadius: 6, border: "1px solid #E4DCC8", display: "block" }}
                />
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent, small }) {
  return (
    <div className={`rounded-xl border ${small ? "p-2.5" : "p-3.5"}`} style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <div className="text-xs mb-1" style={{ color: "var(--ink-soft)" }}>{label}</div>
      <div className={`mono-font font-semibold ${small ? "text-sm" : "text-lg"}`} style={{ color: accent ? "var(--accent)" : "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ============== Shared bits ==============

function EmptyState({ text }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
      {text}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1" style={{ color: "var(--ink-soft)" }}>{label}</label>
      {children}
    </div>
  );
}

// Two-click delete guard: first click arms it ("Delete?"), a second click within
// a few seconds confirms. Arms back down automatically, or if the mouse leaves.
// `compact` renders as a small icon-only circle (for tight spaces) instead of a
// label pill — armed state is shown via a filled red background + tooltip.
function ConfirmDeleteButton({ onConfirm, className, size = 12, round = true, label = "Delete?", compact = false }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (compact) {
    return (
      <button
        title={armed ? "Click again to delete" : "Delete"}
        onClick={() => (armed ? (onConfirm(), setArmed(false)) : setArmed(true))}
        onMouseLeave={() => setArmed(false)}
        className={`w-6 h-6 flex items-center justify-center rounded-full ${armed ? "" : ""}`}
        style={armed ? { background: "var(--alert)" } : undefined}
      >
        <Trash2 size={size} color={armed ? "#fff" : "var(--alert)"} />
      </button>
    );
  }
  if (armed) {
    return (
      <button
        onClick={() => { onConfirm(); setArmed(false); }}
        onMouseLeave={() => setArmed(false)}
        className={`flex items-center gap-1 text-xs px-2 rounded-full font-medium ${className || ""}`}
        style={{ background: "var(--alert)", color: "#fff", height: round ? 28 : undefined }}
      >
        <Trash2 size={size} /> {label}
      </button>
    );
  }
  return (
    <button
      onClick={() => setArmed(true)}
      className={className || (round ? "w-7 h-7 flex items-center justify-center rounded-full border" : "")}
      style={round ? { borderColor: "var(--line)" } : undefined}
    >
      <Trash2 size={size} color="var(--alert)" />
    </button>
  );
}

// ============== Sign-Up / Login / Settings ==============

function AuthCard({ children }) {
  return (
    <div className="min-h-[75vh] flex items-center justify-center px-4 py-10 no-print">
      <div className="w-full max-w-sm rounded-2xl border p-6 sm:p-7" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
        {/* Install is offered here too, not just after logging in — most
            owners install the app once, on the device they use every shift,
            long before they'd think to look for it in Settings. */}
        <div className="flex justify-end mb-3">
          <InstallAppButton size="small" />
        </div>
        {children}
        <div className="flex justify-center mt-4">
          <TermsGuidelinesButton />
        </div>
      </div>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder, autoFocus, onKeyDown }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full border rounded-lg px-3 py-2 text-sm pr-9"
        style={{ borderColor: "var(--line)" }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2"
        tabIndex={-1}
        title={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={14} color="var(--ink-soft)" /> : <Eye size={14} color="var(--ink-soft)" />}
      </button>
    </div>
  );
}

// First-time setup screen — creates the one owner account this café's POS
// runs under. Shown when the owner clicks over from the login screen (or
// this is the very first thing they ever open — see onSwitchToLogin).
function SignUpView({ onSignUp, onSwitchToLogin }) {
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Chosen once, here, at setup — this becomes the account's permanent
  // billing/display currency. There's no way to change it later in
  // Settings; the subscription price is only ever shown in this one
  // currency going forward, so switching currencies to "shop" for a
  // cheaper-looking price isn't possible.
  // Starts BLANK on purpose — an owner has to actively pick a currency
  // rather than silently inheriting a PHP default they may not have
  // noticed. See the "Select a currency" placeholder option below and the
  // validation in submit().
  const [currencyCode, setCurrencyCode] = useState("");
  const [error, setError] = useState("");
  // True only when the error is specifically "this email already has an
  // account" — lets us show a one-click "Log in instead" link rather than
  // just a plain error line, since that's actually the fix, not a retry.
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setAlreadyExists(false);
    if (!businessName.trim()) { setError("Enter your business name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    if (!currencyCode) { setError("Please select a currency."); return; }
    setError("");
    setBusy(true);
    const result = await onSignUp({ businessName, email, password, currencyCode, referralCode: "" });
    setBusy(false);
    if (result !== true) {
      setError(result || "Couldn't create the account — check your connection and try again.");
      if (/already exists/i.test(result || "")) setAlreadyExists(true);
    }
  };
  const onEnter = (e) => { if (e.key === "Enter") submit(); };

  return (
    <AuthCard>
      <div>
        <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
        <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>Set up your café</h1>
        <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>
          Create an owner account to get started. Business name, email, and password can be changed later in Settings — your currency can't, so pick the right one now.
        </p>
        <div className="space-y-3">
          <Field label="Business name">
            <input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              onKeyDown={onEnter}
              placeholder="e.g. Sunrise Café"
              autoFocus
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onEnter}
              placeholder="you@example.com"
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
          <Field label="Password">
            <PasswordInput value={password} onChange={setPassword} onKeyDown={onEnter} placeholder="At least 6 characters" />
          </Field>
          <Field label="Confirm password">
            <PasswordInput value={confirm} onChange={setConfirm} onKeyDown={onEnter} placeholder="Retype password" />
          </Field>
          <Field label="Currency">
            <select
              value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)", color: currencyCode ? "inherit" : "var(--ink-soft)" }}
            >
              <option value="" disabled>Select a currency…</option>
              {CURRENCIES_ALPHABETICAL.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            <p className="text-[10px] mt-1" style={{ color: "var(--ink-soft)" }}>
              Used for both your POS totals and your subscription price. This can't be changed after setup.
            </p>
          </Field>
        </div>
        {error && (
          <p className="text-xs mt-3" style={{ color: "var(--alert)" }}>
            {error}
            {alreadyExists && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="underline font-medium"
                  style={{ color: "var(--alert)" }}
                >
                  Log in instead
                </button>
              </>
            )}
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="w-full mt-5 py-2.5 rounded-lg text-sm font-medium"
          style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
        <p className="text-xs text-center mt-4" style={{ color: "var(--ink-soft)" }}>
          Already have an account?{" "}
          <button type="button" onClick={onSwitchToLogin} className="underline font-medium" style={{ color: "var(--primary)" }}>
            Log in
          </button>
        </p>
        <p className="text-[11px] text-center mt-3" style={{ color: "var(--ink-soft)" }}>
          Need help? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "var(--primary)" }}>{SUPPORT_EMAIL}</a>
        </p>
      </div>
    </AuthCard>
  );
}

// The default screen shown on first load and any time the owner isn't
// logged in on this device — a normal login form, with a link over to
// SignUpView for anyone who genuinely needs a new account.
function LoginView({ account, onLogIn, onResetPassword, onSwitchToSignUp }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Toggles the login form over to a lightweight "send me a reset link"
  // form, reusing whatever email the owner already typed.
  const [forgotMode, setForgotMode] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    const result = await onLogIn({ email, password });
    setBusy(false);
    if (result !== true) setError(result || "Email or password is incorrect.");
  };
  const onEnter = (e) => { if (e.key === "Enter") submit(); };

  if (forgotMode) {
    return (
      <AuthCard>
        <ForgotPasswordForm
          initialEmail={email}
          onSend={onResetPassword}
          onBack={() => setForgotMode(false)}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <div>
        <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
        <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>
          {account?.businessName || "Welcome back"}
        </h1>
        <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>Log in to open the register.</p>
        <div className="space-y-3">
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onEnter}
              placeholder="you@example.com"
              autoFocus
              className="w-full border rounded-lg px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </Field>
          <div>
            <Field label="Password">
              <PasswordInput value={password} onChange={setPassword} onKeyDown={onEnter} placeholder="Your password" />
            </Field>
            <button
              type="button"
              onClick={() => { setError(""); setForgotMode(true); }}
              className="text-[11px] underline mt-1.5"
              style={{ color: "var(--ink-soft)" }}
            >
              Forgot password?
            </button>
          </div>
        </div>
        {error && <p className="text-xs mt-3" style={{ color: "var(--alert)" }}>{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="w-full mt-5 py-2.5 rounded-lg text-sm font-medium"
          style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Logging in…" : "Log in"}
        </button>
        <p className="text-xs text-center mt-4" style={{ color: "var(--ink-soft)" }}>
          New here?{" "}
          <button type="button" onClick={onSwitchToSignUp} className="underline font-medium" style={{ color: "var(--primary)" }}>
            Create an account
          </button>
        </p>
      </div>
    </AuthCard>
  );
}

// Inline "send me a reset link" form, shown in place of the login form when
// the owner taps "Forgot password?". Always ends in the same neutral
// confirmation message on success, whether or not that email actually has
// an account — Supabase's API doesn't distinguish the two either, so there's
// nothing more specific to tell them.
function ForgotPasswordForm({ initialEmail, onSend, onBack }) {
  const [email, setEmail] = useState(initialEmail || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setError("");
    setBusy(true);
    const result = await onSend(email);
    setBusy(false);
    if (result === true) setSent(true);
    else setError(result || "Couldn't send the reset email — please try again.");
  };
  const onEnter = (e) => { if (e.key === "Enter") submit(); };

  if (sent) {
    return (
      <div>
        <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
        <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>Check your email</h1>
        <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>
          If an account exists for <b>{email.trim()}</b>, we've sent a link to reset the password. Open it on this device to choose a new one.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="w-full py-2.5 rounded-lg text-sm font-medium border"
          style={{ borderColor: "var(--line)", color: "var(--ink)" }}
        >
          Back to log in
        </button>
      </div>
    );
  }

  return (
    <div>
      <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
      <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>Reset your password</h1>
      <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>
        Enter the email you registered with and we'll send you a link to set a new password.
      </p>
      <Field label="Email">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onEnter}
          placeholder="you@example.com"
          autoFocus
          className="w-full border rounded-lg px-3 py-2 text-sm"
          style={{ borderColor: "var(--line)" }}
        />
      </Field>
      {error && <p className="text-xs mt-3" style={{ color: "var(--alert)" }}>{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="w-full mt-5 py-2.5 rounded-lg text-sm font-medium"
        style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
      >
        {busy ? "Sending…" : "Send reset link"}
      </button>
      <p className="text-xs text-center mt-4" style={{ color: "var(--ink-soft)" }}>
        <button type="button" onClick={onBack} className="underline font-medium" style={{ color: "var(--primary)" }}>
          Back to log in
        </button>
      </p>
    </div>
  );
}

// Shown when the owner arrives back in the app via the password-reset email
// link (a PASSWORD_RECOVERY session). They must set a new password before
// doing anything else — there's no way to dismiss this into the main app.
function ResetPasswordView({ onConfirm, onCancel }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setError("");
    setBusy(true);
    const result = await onConfirm(password);
    setBusy(false);
    if (result !== true) setError(result || "Couldn't update your password — please try again.");
  };
  const onEnter = (e) => { if (e.key === "Enter") submit(); };

  return (
    <AuthCard>
      <div>
        <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
        <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>Choose a new password</h1>
        <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>
          You're resetting your password. Pick a new one to finish logging in.
        </p>
        <div className="space-y-3">
          <Field label="New password">
            <PasswordInput value={password} onChange={setPassword} onKeyDown={onEnter} placeholder="At least 6 characters" />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput value={confirm} onChange={setConfirm} onKeyDown={onEnter} placeholder="Retype password" />
          </Field>
        </div>
        {error && <p className="text-xs mt-3" style={{ color: "var(--alert)" }}>{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="w-full mt-5 py-2.5 rounded-lg text-sm font-medium"
          style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Saving…" : "Save new password"}
        </button>
        <p className="text-xs text-center mt-4" style={{ color: "var(--ink-soft)" }}>
          <button type="button" onClick={onCancel} className="underline font-medium" style={{ color: "var(--ink-soft)" }}>
            Cancel and log out
          </button>
        </p>
      </div>
    </AuthCard>
  );
}

// A text/email/password field that saves itself a moment after the owner
// stops typing — no Save button needed. Shows a tiny "Saving…" / "Saved ✓"
// status underneath so it's obvious it worked.
function AutoSaveField({ label, value, onSave, type = "text", placeholder, minLength = 0, helper }) {
  const [val, setVal] = useState(value || "");
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [show, setShow] = useState(false);
  const timerRef = useRef(null);
  const savedRef = useRef(value || "");

  useEffect(() => {
    setVal(value || "");
    savedRef.current = value || "";
  }, [value]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleChange = (v) => {
    setVal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = type === "password" ? v : v.trim();
    if (trimmed === savedRef.current) { setStatus("idle"); return; }
    if (trimmed.length < minLength) { setStatus("idle"); return; }
    setStatus("saving");
    timerRef.current = setTimeout(async () => {
      const ok = await onSave(trimmed);
      if (ok === false) { setStatus("error"); return; }
      savedRef.current = trimmed;
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1800);
    }, 700);
  };

  return (
    <Field label={label}>
      <div className="relative">
        <input
          type={type === "password" && !show ? "password" : "text"}
          value={val}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className="w-full border rounded-lg px-3 py-2 text-sm pr-16"
          style={{ borderColor: "var(--line)" }}
        />
        {type === "password" && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-9 top-1/2 -translate-y-1/2"
            tabIndex={-1}
            title={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={14} color="var(--ink-soft)" /> : <Eye size={14} color="var(--ink-soft)" />}
          </button>
        )}
      </div>
      <div className="h-4 mt-1 text-[11px] flex items-center gap-1" style={{ color: status === "error" ? "var(--alert)" : "var(--ink-soft)" }}>
        {status === "saving" && (<><Loader2 size={11} className="animate-spin" /> Saving…</>)}
        {status === "saved" && (<span style={{ color: "var(--primary-dark)" }}>Saved ✓</span>)}
        {status === "error" && "Couldn't save — try again"}
        {status === "idle" && helper}
      </div>
    </Field>
  );
}

// Shown either as a full-page block (trial expired, onClose === null) or as
// a dismissable modal (owner opened it voluntarily from the trial banner or
// Settings, onClose is a function). Sends the owner to PayMongo (GCash/
// Maya/local cards) if they're billed in PHP, or to PayPal if they're
// billed in any other currency — see isPHCustomer below. BOTH are fully
// automatic, for both the amount charged AND confirming the payment:
//  - PayMongo: startPayMongoCheckout() below calls
//    api/create-paymongo-link.js to create a fresh Payment Link at the
//    exact amount shown, then api/paymongo-webhook.js activates the
//    account the moment it's paid. See PAYMONGO_CREATE_LINK_ENDPOINT near
//    the top of this file.
//  - PayPal: startPayPalCheckout() below calls api/create-paypal-order.js
//    to create a real PayPal Order at the exact amount shown, then
//    api/paypal-webhook.js activates the account the moment it's paid. See
//    PAYPAL_CREATE_ORDER_ENDPOINT near the top of this file.
// Either way, there's no fixed-price link to keep in sync with an
// ever-changing discount, the amount charged always matches the amount
// shown, and the account is activated automatically — no manual
// reconciling needed. onConfirm/markSubscriptionActive is still there as a
// fallback for the manual-payment note (needsManualPayment below), for the
// rare case a live checkout call fails or a currency PayPal doesn't settle
// in at all.
function UpgradeView({ account, trialInfo, currencyCode = "PHP", onConfirm, onApplyCode, onClose, onLogOut, onRefreshAccount, notify }) {
  const [code, setCode] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState("");
  // Controls the in-app checkout overlay (see checkoutModal below) — payment
  // now happens inside the POS in an embedded frame instead of opening
  // PayMongo's/PayPal's checkout in a new browser tab.
  const [showCheckout, setShowCheckout] = useState(false);
  // Tracks the PayMongo dynamic-link request (see startPayMongoCheckout
  // below): "idle" before the subscriber has clicked Pay, "loading" while
  // api/create-paymongo-link.js is being called, "ready" once it's handed
  // back a checkout url (at which point showCheckout flips on), and "error"
  // if that call fails for any reason — in which case the manual-payment
  // fallback (manualPaymentNote/manualPaymentAmount below) is shown instead
  // so a subscriber is never just stuck with a dead "Pay now" button.
  const [paymongoState, setPaymongoState] = useState({ status: "idle", url: "", error: "" });
  // Same idea as paymongoState, for international subscribers — see
  // startPayPalCheckout below and PAYPAL_CREATE_ORDER_ENDPOINT near the top
  // of this file.
  const [paypalState, setPaypalState] = useState({ status: "idle", url: "", error: "" });
  // Briefly true right after a code is successfully applied, so the price
  // box can flash/highlight and make the before → after change obvious
  // instead of just silently re-rendering with new numbers.
  const [justApplied, setJustApplied] = useState(false);
  // Reference number/text the subscriber types in after paying manually
  // (GCash/bank transfer for PH, or PayPal.me for international currencies
  // PayPal itself can't settle in — see needsManualPayment below). Submitting
  // this calls onConfirm/markSubscriptionActive, which is the ONLY thing
  // that actually activates the account on the manual-payment path, since
  // there's no webhook to do it automatically the way PayMongo/PayPal
  // checkout does.
  const [manualRef, setManualRef] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState("");

  const applyCode = async () => {
    if (codeBusy) return;
    setCodeError("");
    setCodeBusy(true);
    // try/finally so codeBusy is guaranteed to reset even if onApplyCode
    // ever throws instead of returning a string/true — previously an
    // unhandled exception here left the button stuck disabled forever
    // with zero feedback (no toast, no error message).
    try {
      const result = await onApplyCode(code);
      if (result !== true) {
        setCodeError(result || "That code isn't valid.");
      } else {
        setCode("");
        // Trigger the highlight; auto-clear so it doesn't stay on forever.
        setJustApplied(true);
        window.setTimeout(() => setJustApplied(false), 1600);
      }
    } catch (err) {
      console.error("Applying referral code failed unexpectedly:", err);
      setCodeError("Something went wrong applying that code. Please try again.");
    } finally {
      setCodeBusy(false);
    }
  };

  // Has this account ever paid before? Only a renewal (true) earns reward
  // credits toward its price; only a first-ever payment (false) can use the
  // one-time referral signup discount.
  const hasSubscribedBefore = account?.subscriptionStatus === "active";
  const signupDiscountPercent = account?.discountPercent || 0;
  const rewardCreditPercent = Math.min(account?.rewardCredits || 0, MAX_REWARD_CREDIT_PERCENT);
  const discountPercent = hasSubscribedBefore ? rewardCreditPercent : signupDiscountPercent;

  // ---- Multi-currency, fixed-rate-locked pricing ----
  // `fullPrice`/`discountAmount`/`finalPrice` are all in the subscriber's
  // chosen display currency, read from the LOCKED_SUBSCRIPTION_PRICE_PHP
  // table (see its comment near the top of the file) — never a live/daily
  // conversion, so the number on screen for a given currency never moves
  // day to day. `phpFullPrice`/`phpFinalPrice` are the real PHP amounts,
  // since that's what PayMongo/manual payment actually settles in.
  const fullPrice = lockedSubscriptionPrice(currencyCode);
  const discountAmount = fullPrice * (discountPercent / 100);
  const finalPrice = fullPrice - discountAmount;
  const phpFullPrice = MONTHLY_PRICE_PHP;
  const phpDiscountAmount = phpFullPrice * (discountPercent / 100);
  const phpFinalPrice = Math.round(phpFullPrice - phpDiscountAmount);
  const fmt = (n) => formatSubscriptionAmount(n, currencyCode);
  const fmtPhp = (n) => formatSubscriptionAmount(n, "PHP");

  // ---- Payment provider: PayMongo (Philippines) vs PayPal (everywhere
  // else) ----
  // PayMongo only settles Philippine payment methods, so it's only offered
  // to subscribers billed in PHP. Every other currency uses PayPal instead
  // — there's no PayMongo option shown to them at all.
  const isPHCustomer = currencyCode === "PHP";

  // Both PayMongo and PayPal are now fully automatic for any discount
  // amount AND any currency — see the big comment above this component and
  // startPayPalCheckout below (it auto-switches to USD for currencies
  // PayPal itself can't settle in, e.g. INR/IDR/VND — see
  // PAYPAL_SUPPORTED_CURRENCIES above). The ONLY remaining reason either
  // falls back to manual payment is the live API call itself failing:
  //  - PayMongo (PH): the live call to api/create-paymongo-link.js failed
  //    (see paymongoState below).
  //  - PayPal (everyone else): the live call to api/create-paypal-order.js
  //    failed (see paypalState below) — no longer gated on currency at all,
  //    since startPayPalCheckout now always sends a currency PayPal accepts.
  const needsManualPayment = isPHCustomer
    ? paymongoState.status === "error"
    : paypalState.status === "error";
  // True when this subscriber's billing currency isn't one PayPal itself
  // settles in — used by startPayPalCheckout below to switch the LIVE order
  // to USD instead (still fully automatic), and by the UI to explain why
  // the checkout amount shown is in USD rather than their own currency.
  const paypalNeedsUsd = !isPHCustomer && !PAYPAL_SUPPORTED_CURRENCIES.has(currencyCode);
  // Both PH and international checkout URLs now come from a serverless
  // function call — empty until the subscriber clicks "Pay now" (see
  // startPayMongoCheckout/startPayPalCheckout below), which is what
  // triggers fetching them.
  const payLink = isPHCustomer ? paymongoState.url : paypalState.url;
  const manualPaymentNote = isPHCustomer ? MANUAL_PAYMENT_NOTE_PH : MANUAL_PAYMENT_NOTE_INTL;
  // For the PH manual fallback this is the real PHP amount (what GCash/
  // bank transfer actually settles in). For the international manual
  // fallback (unsupported currency only, see above) this is a USD amount
  // instead of the subscriber's own currency, since by definition PayPal
  // won't take their own currency — USD is the one every PayPal account can
  // send/receive.
  const usdFullPrice = lockedSubscriptionPrice("USD");
  const usdFinalPrice = usdFullPrice - usdFullPrice * (discountPercent / 100);
  const manualPaymentAmount = isPHCustomer ? fmtPhp(phpFinalPrice) : formatSubscriptionAmount(usdFinalPrice, "USD");

  // Whenever the amount actually due changes — a referral code just got
  // applied, reward credits changed, whatever — throw away any PayMongo
  // link fetched for the OLD amount. Without this, closing and reopening
  // the checkout modal after applying a code could show a stale checkout
  // page still priced at the old amount.
  useEffect(() => {
    setPaymongoState({ status: "idle", url: "", error: "" });
  }, [phpFinalPrice]);

  // Same idea, for the PayPal Order (see startPayPalCheckout below) — an
  // Order is created for one fixed amount, so a stale one from before a
  // referral code/discount changed the price must be thrown away too.
  useEffect(() => {
    setPaypalState({ status: "idle", url: "", error: "" });
  }, [finalPrice, currencyCode]);

  // Calls api/create-paymongo-link.js to create a fresh PayMongo Payment
  // Link priced at the EXACT amount shown on screen (phpFinalPrice — full
  // price, the one-time 25% signup discount, or any accumulated
  // reward-credit % already baked in), then opens the in-app checkout with
  // that link. See PAYMONGO_CREATE_LINK_ENDPOINT near the top of this file
  // for what this calls and the one-time Vercel setup it needs.
  const startPayMongoCheckout = useCallback(async () => {
    // IMPORTANT: the popup window must be opened synchronously, in direct
    // response to the click — not after an await. Browsers only allow
    // window.open() without being treated as a blocked popup when it's a
    // direct reaction to a user gesture; by the time an awaited fetch()
    // resolves, that "direct gesture" window has closed and the popup
    // gets silently blocked (falling back to a full new tab instead). So
    // we open a blank popup right here, then point it at the real
    // checkout URL once we have it.
    const popup = openPaymentPopup("about:blank");
    setPaymongoState({ status: "loading", url: "", error: "" });
    try {
      const resp = await fetch(PAYMONGO_CREATE_LINK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPhp: phpFinalPrice,
          description: `OpSteward QuickServe POS — ${hasSubscribedBefore ? "renewal" : "subscription"}${
            account?.businessName ? ` for ${account.businessName}` : ""
          }`,
          // Lets api/paymongo-webhook.js know whose account to activate
          // once this link gets paid — see that file's setup comment for
          // the full automatic-activation flow this enables.
          businessId: account?.id,
        }),
      });
      let data = null;
      try {
        data = await resp.json();
      } catch {
        // Non-JSON response (e.g. the endpoint 404ed because the
        // serverless function hasn't been added/deployed yet) — fall
        // through to the generic error below instead of throwing here.
      }
      // A 100% discount brings phpFinalPrice to exactly ₱0 — PayMongo can't
      // create a checkout session for ₱0, so create-paymongo-link.js
      // activates the subscription directly instead of returning a
      // checkout url. Nothing to redirect the popup to; just close it,
      // refresh the account, and clearly tell the subscriber what happened
      // to this month's bill — since no payment screen ever appeared, they
      // have no other way of knowing it was actually covered rather than
      // silently skipped.
      if (data?.activated) {
        if (popup && !popup.closed) popup.close();
        setPaymongoState({ status: "idle", url: "", error: "" });
        await onRefreshAccount?.();
        notify?.(
          `This month's bill (${fmtPhp(phpFullPrice)}) was fully covered by your ${discountPercent}% ` +
            `${hasSubscribedBefore ? "reward credit" : "referral discount"} — nothing to pay, and your ` +
            `subscription is active for the next ${SUBSCRIPTION_PERIOD_DAYS} days. Reward credit resets to ` +
            `0% next cycle, so next month's bill will be ${fmtPhp(phpFullPrice)} unless new referrals come in.`
        );
        if (typeof onClose === "function") onClose();
        return;
      }
      if (!resp.ok || !data?.url) {
        throw new Error(data?.error || "Couldn't reach PayMongo just now.");
      }
      setPaymongoState({ status: "ready", url: data.url, error: "" });
      if (popup && !popup.closed) {
        // Redirect the already-open popup to the real checkout link, then
        // pin its size again — navigating to the real page is another
        // moment where the destination could resize/maximize itself.
        popup.location.href = data.url;
        popup.focus();
        pinPopupSize(popup, 480, 720, popup.screenX, popup.screenY);
        pollForActivation(popup);
      } else {
        // The pre-opened popup itself got blocked (rare, but possible) —
        // fall back to a plain new tab so payment is still reachable.
        window.open(data.url, "_blank", "noopener,noreferrer");
        pollForActivation(null);
      }
    } catch (err) {
      console.error("startPayMongoCheckout failed:", err);
      setPaymongoState({ status: "error", url: "", error: err.message || "Something went wrong." });
      // Nothing to show in the popup we opened — close it rather than
      // leaving a blank window sitting on screen after a failed request.
      if (popup && !popup.closed) popup.close();
    }
  }, [phpFinalPrice, hasSubscribedBefore, account?.businessName]);

  // Calls api/create-paypal-order.js to create a real PayPal Order priced
  // at the EXACT amount shown on screen, with this account's id attached
  // (so api/paypal-webhook.js knows who to activate once it's paid), then
  // opens the in-app checkout with the approval link PayPal hands back.
  // Mirrors startPayMongoCheckout above — see PAYPAL_CREATE_ORDER_ENDPOINT
  // near the top of this file for the one-time setup this needs.
  const startPayPalCheckout = useCallback(async () => {
    // Same reasoning as startPayMongoCheckout: open the popup synchronously,
    // in direct response to the click, then redirect it once we have the
    // real checkout URL — otherwise the browser may block it.
    const popup = openPaymentPopup("about:blank");
    setPaypalState({ status: "loading", url: "", error: "" });
    // If this subscriber's billing currency isn't one PayPal itself settles
    // in (INR/IDR/VND — see PAYPAL_SUPPORTED_CURRENCIES above), create the
    // live Order in USD instead of their own currency. This is what keeps
    // checkout fully automatic for them too, instead of falling back to a
    // manual reference — PayPal simply cannot create an Order in a currency
    // it doesn't support, no matter how the request is built, so USD (the
    // one currency every PayPal account can send/receive) is the only way
    // to still get a real, live, auto-activating checkout link.
    const orderAmount = paypalNeedsUsd ? usdFinalPrice : finalPrice;
    const orderCurrency = paypalNeedsUsd ? "USD" : currencyCode;
    try {
      const resp = await fetch(PAYPAL_CREATE_ORDER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: orderAmount,
          currency: orderCurrency,
          description: `OpSteward QuickServe POS — ${hasSubscribedBefore ? "renewal" : "subscription"}${
            account?.businessName ? ` for ${account.businessName}` : ""
          }`,
          // Lets api/paypal-webhook.js know whose account to activate once
          // this order is paid — see activate_subscription() in the SQL
          // setup block near the top of this file.
          businessId: account?.id,
        }),
      });
      let data = null;
      try {
        data = await resp.json();
      } catch {
        // Non-JSON response (e.g. the endpoint 404ed because the
        // serverless function hasn't been added/deployed yet).
      }
      // A 100% discount brings the order amount to exactly 0 — PayPal can't
      // create an order for $0, so create-paypal-order.js activates the
      // subscription directly instead of returning a checkout url.
      // Mirrors the same ₱0 case in startPayMongoCheckout above.
      if (data?.activated) {
        if (popup && !popup.closed) popup.close();
        setPaypalState({ status: "idle", url: "", error: "" });
        await onRefreshAccount?.();
        notify?.(
          `This month's bill (${fmt(fullPrice)}) was fully covered by your ` +
            `${discountPercent}% ${hasSubscribedBefore ? "reward credit" : "referral discount"} — nothing to ` +
            `pay, and your subscription is active for the next ${SUBSCRIPTION_PERIOD_DAYS} days. Reward credit ` +
            `resets to 0% next cycle, so next month's bill will be ${fmt(fullPrice)} unless new referrals come in.`
        );
        if (typeof onClose === "function") onClose();
        return;
      }
      if (!resp.ok || !data?.url) {
        throw new Error(data?.error || "Couldn't reach PayPal just now.");
      }
      setPaypalState({ status: "ready", url: data.url, error: "" });
      if (popup && !popup.closed) {
        popup.location.href = data.url;
        popup.focus();
        pinPopupSize(popup, 480, 720, popup.screenX, popup.screenY);
        pollForActivation(popup);
      } else {
        window.open(data.url, "_blank", "noopener,noreferrer");
        pollForActivation(null);
      }
    } catch (err) {
      console.error("startPayPalCheckout failed:", err);
      setPaypalState({ status: "error", url: "", error: err.message || "Something went wrong." });
      if (popup && !popup.closed) popup.close();
    }
  }, [finalPrice, currencyCode, paypalNeedsUsd, usdFinalPrice, hasSubscribedBefore, account?.businessName, account?.id]);

  // What the "Pay now" button actually does: both PH and international
  // subscribers now need a fresh checkout link fetched first (async) —
  // startPayMongoCheckout / startPayPalCheckout above.
  // Opens a checkout link as a small centered popup WINDOW (not an iframe
  // embedded in this page, and not a full new tab) — e.g. roughly the size
  // of a card-payment form, positioned in the middle of the user's screen.
  // This works around PayMongo/PayPal blocking iframes (X-Frame-Options/
  // CSP) because a popup is a separate browser window, not an embed — those
  // headers only block the iframe case, not this one. If the browser or an
  // ad-blocker blocks the popup (returns null/closed), we fall back to a
  // normal new tab so the subscriber can still always complete payment.
  const openPaymentPopup = (url) => {
    const popupWidth = 480;
    const popupHeight = 720;
    const left = Math.round(window.screenX + (window.outerWidth - popupWidth) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - popupHeight) / 2);
    const features = `width=${popupWidth},height=${popupHeight},left=${left},top=${top},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no`;
    const popup = window.open(url, "paymentCheckout", features);
    if (!popup || popup.closed) {
      // Popup blocked — fall back to a plain new tab rather than leaving
      // the subscriber with no way to pay at all.
      window.open(url, "_blank", "noopener,noreferrer");
      return null;
    }
    popup.focus();
    pinPopupSize(popup, popupWidth, popupHeight, left, top);
    return popup;
  };

  // Some hosted checkout pages resize/maximize their own window once they
  // finish loading (common for "make the payment form full-size" UX on
  // their end) — that overrides the small size we opened the popup at.
  // resizeTo/moveTo are allowed cross-origin because they act on the
  // window itself (not its cross-origin content), so we can keep pulling
  // it back to our fixed size. We do this repeatedly for a few seconds
  // after opening/navigating, then stop — long enough to override the
  // checkout page's own onload resize script, short enough that we're not
  // fighting the subscriber if they manually resize it later themselves.
  const pinPopupSize = (popup, w, h, left, top) => {
    let ticks = 0;
    const maxTicks = 10; // ~3 seconds at 300ms each
    const interval = setInterval(() => {
      ticks += 1;
      if (!popup || popup.closed || ticks >= maxTicks) {
        clearInterval(interval);
        return;
      }
      try {
        popup.resizeTo(w, h);
        popup.moveTo(left, top);
      } catch {
        // Some browsers restrict resizeTo/moveTo depending on how the
        // window was opened — if it throws, just stop trying rather than
        // spamming errors every tick.
        clearInterval(interval);
      }
    }, 300);
  };

  // While the payment popup is open, a webhook (api/paymongo-webhook.js for
  // PH, api/paypal-webhook.js for everyone else) may flip subscription_status
  // to "active" in the database at any moment — but nothing tells THIS
  // already-open browser tab that happened. Without this, an owner who
  // successfully pays still sees "Time to renew"/a locked POS until they
  // manually reload the page. This polls the business row every few seconds
  // while the popup is open (plus a few extra checks right after it's
  // closed, in case the webhook is a beat slower than the subscriber
  // closing the window) and, the moment the account comes back active,
  // updates account state — which lets trialInfo recompute and the lock
  // screen disappear automatically — and closes the popup + the Upgrade
  // modal itself.
  const pollForActivation = (popup) => {
    if (!onRefreshAccount) return;
    let ticks = 0;
    const maxTicks = 150; // ~10 minutes at 4s each — generous, but finite
    let popupClosedAt = null;
    const interval = setInterval(async () => {
      ticks += 1;
      if (popup && popup.closed && popupClosedAt === null) {
        popupClosedAt = ticks;
      }
      // Keep checking for a short grace window after the popup closes
      // (webhook delivery isn't instant), then give up.
      const stopAfterClose = popupClosedAt !== null && ticks - popupClosedAt > 4; // ~16s grace
      if (ticks >= maxTicks || stopAfterClose) {
        clearInterval(interval);
        return;
      }
      const fresh = await onRefreshAccount();
      const periodEndMs = fresh?.subscriptionPeriodEnd ? new Date(fresh.subscriptionPeriodEnd).getTime() : NaN;
      const isNowActive = fresh?.subscriptionStatus === "active" && Number.isFinite(periodEndMs) && periodEndMs > Date.now();
      if (isNowActive) {
        clearInterval(interval);
        if (popup && !popup.closed) popup.close();
        // For the voluntary modal (onClose is a function) close it too, so
        // the owner lands straight back on their unlocked POS instead of
        // an empty upgrade screen. The hard-block case (onClose === null)
        // doesn't need this — trialInfo.isSubscribed flipping true is what
        // makes the App stop rendering the block at all.
        if (typeof onClose === "function") onClose();
      }
    }, 4000);
  };

  const handlePayClick = () => {
    if (isPHCustomer) {
      startPayMongoCheckout();
    } else {
      startPayPalCheckout();
    }
  };

  // PayPal.me link for the international manual-payment fallback (currency
  // PayPal doesn't settle in, e.g. INR/IDR/VND — see PAYPAL_SUPPORTED_CURRENCIES
  // above). Priced in USD since that's the one currency every PayPal account
  // can send/receive, matching manualPaymentAmount below.
  const manualPayPalLink = buildPayPalLink(usdFinalPrice, "USD");

  // Submits the self-reported reference for the manual-payment fallback
  // (PH: GCash/bank transfer; international: PayPal.me) and activates the
  // account via onConfirm/markSubscriptionActive — mirrors the ₱0/$0
  // free-activation notify() messaging used elsewhere in this file.
  const submitManualPayment = async () => {
    if (manualBusy || !manualRef.trim()) return;
    setManualError("");
    setManualBusy(true);
    try {
      const ok = await onConfirm?.(manualRef.trim());
      if (ok === false) {
        setManualError("Couldn't confirm the upgrade. Please try again.");
      } else {
        setManualRef("");
        notify?.(
          `Thanks! We've noted your payment reference and activated your subscription for the next ${SUBSCRIPTION_PERIOD_DAYS} days.`
        );
        if (typeof onClose === "function") onClose();
      }
    } catch (err) {
      console.error("submitManualPayment failed:", err);
      setManualError("Something went wrong confirming that. Please try again.");
    } finally {
      setManualBusy(false);
    }
  };

  // A previously-unsubscribed owner (see unsubscribeAccount() in the main
  // App component) lands here with subscription_status === "cancelled" —
  // trialInfo treats that the same as never having subscribed (expired,
  // not renewalDue, hasSubscribedBefore false), so without this check
  // they'd see the generic "free trial has ended" copy. This gives them
  // copy that actually matches what happened, while everything below (the
  // price breakdown, the "subscription" vs "renewal" wording, the
  // referral-code eligibility) already correctly treats them as a NEW
  // subscriber for free, since it all keys off hasSubscribedBefore/
  // account.subscriptionStatus rather than this headline.
  const wasUnsubscribed = account?.subscriptionStatus === "cancelled";
  const headline = trialInfo?.renewalDue
    ? "Time to renew"
    : wasUnsubscribed
    ? "You've unsubscribed"
    : trialInfo?.expired
    ? "Your free trial has ended"
    : hasSubscribedBefore
    ? "Manage your subscription"
    : "Upgrade your account";
  const subhead = trialInfo?.renewalDue
    ? "Your paid period has ended — renew to keep the counter running. Your data is safe and right where you left it."
    : wasUnsubscribed
    ? "Resubscribe any time to keep using your POS — your data is safe and right where you left it."
    : trialInfo?.expired
    ? "Subscribe to keep using your POS — your data is safe and will be right where you left it."
    : hasSubscribedBefore
    ? "Renew early any time, or just keep an eye on your reward credit."
    : "Subscribe any time to keep the counter running after your trial ends.";

  const body = (
    <div className="max-w-sm mx-auto">
      <img src={LOGO_DATA_URL} alt="" className="h-12 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
      <h2 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>{headline}</h2>
      <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>{subhead}</p>

      {/* ---- Price breakdown ----
          New sign-up with a code: Original Price / 25% Referral Discount /
          Final Remaining Balance Due.
          Existing subscriber with reward credit: Next Bill Amount / Earned
          Reward Credit / Updated Remaining Bill Amount. Same three-line
          shape either way — just different labels for the middle/last
          rows, per the two scenarios. */}
      <div
        className="rounded-xl border p-4 mb-4 transition-all duration-500"
        style={{
          borderColor: justApplied ? "#2F6B45" : "var(--line)",
          background: "var(--bg)",
          boxShadow: justApplied ? "0 0 0 3px rgba(47,107,69,0.15)" : "none",
        }}
      >
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: "var(--ink-soft)" }}>{hasSubscribedBefore ? "Next bill amount" : "Original price"}</span>
          <span className={discountPercent > 0 ? "line-through" : ""} style={{ color: discountPercent > 0 ? "var(--ink-soft)" : "inherit" }}>
            {fmt(fullPrice)}/month
          </span>
        </div>
        {discountPercent > 0 && (
          <div className="flex items-center justify-between text-sm mt-1.5">
            <span style={{ color: "#2F6B45" }}>
              {hasSubscribedBefore ? `Earned reward credit (${discountPercent}%, this cycle only)` : `Referral discount (${discountPercent}% off, first month only)`}
            </span>
            <span style={{ color: "#2F6B45" }}>−{fmt(discountAmount)}</span>
          </div>
        )}
        <div
          className="flex items-center justify-between mt-2 pt-2"
          style={{ borderTop: discountPercent > 0 ? "1px dashed var(--line)" : "none" }}
        >
          <span className="text-sm font-medium">{hasSubscribedBefore ? "Updated remaining bill" : "Final balance due"}</span>
          <span className="display-font text-2xl" style={{ fontWeight: 600 }}>{fmt(finalPrice)}<span className="text-sm font-normal">/month</span></span>
        </div>
        {/* ---- Clear "from → to" summary. Recomputes instantly (no reload
            needed) any time discountPercent changes — i.e. the moment a
            referral code is applied, or the moment reward credits change —
            because it's derived straight from the account state React
            already re-renders this view with. ---- */}
        {discountPercent > 0 && (
          <div className="flex items-center justify-center gap-2 mt-3 pt-3 text-xs" style={{ borderTop: "1px solid var(--line)" }}>
            <span style={{ color: "var(--ink-soft)", textDecoration: "line-through" }}>{fmt(fullPrice)}</span>
            <ArrowRight size={12} style={{ color: "var(--ink-soft)" }} />
            <span className="font-semibold" style={{ color: "var(--primary)" }}>{fmt(finalPrice)}</span>
            <span style={{ color: "var(--ink-soft)" }}>({discountPercent}% off)</span>
          </div>
        )}
      </div>

      {/* ---- Discount / referral code — only for a first-ever payment; a
          referral code can't be applied once you're already an active
          subscriber (see redeem_referral() in the SQL setup block). ---- */}
      {!hasSubscribedBefore && (
        signupDiscountPercent > 0 ? (
          <div className="rounded-lg px-3 py-2 mb-4 text-xs" style={{ background: "#EAF0E2", color: "var(--primary-dark)" }}>
            Referral code applied — {signupDiscountPercent}% off your first payment.
          </div>
        ) : (
          <div className="mb-4">
            <Field label="Have a referral code?">
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && applyCode()}
                  placeholder="Enter code"
                  className="flex-1 border rounded-lg px-3 py-2 text-sm uppercase"
                  style={{ borderColor: "var(--line)" }}
                />
                <button
                  type="button"
                  onClick={applyCode}
                  disabled={codeBusy || !code.trim()}
                  className="px-3 py-2 rounded-lg text-xs font-medium border"
                  style={{ borderColor: "var(--primary)", color: "var(--primary)", opacity: codeBusy || !code.trim() ? 0.6 : 1 }}
                >
                  {codeBusy ? "Applying…" : "Apply"}
                </button>
              </div>
            </Field>
            {codeError && <p className="text-xs mt-1.5" style={{ color: "var(--alert)" }}>{codeError}</p>}
          </div>
        )
      )}

      {hasSubscribedBefore && rewardCreditPercent > 0 && (
        <div className="rounded-lg px-3 py-2 mb-4 text-xs" style={{ background: "#EAF0E2", color: "var(--primary-dark)" }}>
          {rewardCreditPercent >= MAX_REWARD_CREDIT_PERCENT
            ? `You've hit the maximum reward credit of ${MAX_REWARD_CREDIT_PERCENT}% off for this billing cycle — it's already reflected in the price above. Extra referrals this month won't lower your bill any further, but the credit resets to 0% next cycle so fresh referrals count again then.`
            : `You're earning ${rewardCreditPercent}% off from your referrals — it's already reflected in the price above.`}
        </div>
      )}

      {needsManualPayment ? (
        <div className="rounded-lg border p-3 text-xs" style={{ borderColor: "var(--line)" }}>
          <div className="font-medium mb-1">Pay {manualPaymentAmount} to activate</div>
          <p style={{ color: "var(--ink-soft)" }}>{manualPaymentNote}</p>
          {/* The live checkout call itself failed (see needsManualPayment
              above — no longer a currency limitation, PayPal orders now
              auto-switch to USD for currencies it can't settle in). Offer a
              one-tap retry before falling back to the manual PayPal.me link
              + self-reported reference below. */}
          <button
            type="button"
            onClick={isPHCustomer ? startPayMongoCheckout : startPayPalCheckout}
            disabled={isPHCustomer ? paymongoState.status === "loading" : paypalState.status === "loading"}
            className="mt-2 text-xs font-medium"
            style={{
              color: "var(--primary)",
              opacity: (isPHCustomer ? paymongoState.status === "loading" : paypalState.status === "loading") ? 0.6 : 1,
            }}
          >
            {(isPHCustomer ? paymongoState.status : paypalState.status) === "loading"
              ? "Retrying…"
              : "Try automatic checkout again"}
          </button>
          {!isPHCustomer && (
            <div className="mt-2">
              <a
                href={manualPayPalLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium"
                style={{ color: "var(--primary)" }}
              >
                <CreditCard size={13} /> Or pay {manualPaymentAmount} via PayPal.me directly
              </a>
            </div>
          )}

          {/* Self-reported confirmation — there's no webhook on this manual
              path, so the owner's account only activates once they submit a
              reference here (see submitManualPayment/onConfirm above). */}
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
            <label className="block mb-1 font-medium" style={{ color: "var(--ink)" }}>
              Already paid? Enter your reference to activate
            </label>
            <div className="flex gap-2">
              <input
                value={manualRef}
                onChange={(e) => setManualRef(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitManualPayment()}
                placeholder={isPHCustomer ? "GCash/bank reference no." : "PayPal transaction ID"}
                className="flex-1 border rounded-lg px-2.5 py-1.5 text-xs"
                style={{ borderColor: "var(--line)" }}
              />
              <button
                type="button"
                onClick={submitManualPayment}
                disabled={manualBusy || !manualRef.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{
                  background: "var(--primary)",
                  color: "#fff",
                  opacity: manualBusy || !manualRef.trim() ? 0.6 : 1,
                }}
              >
                {manualBusy ? "Confirming…" : "Confirm"}
              </button>
            </div>
            {manualError && <p className="mt-1.5" style={{ color: "var(--alert)" }}>{manualError}</p>}
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={handlePayClick}
            disabled={isPHCustomer ? paymongoState.status === "loading" : paypalState.status === "loading"}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium"
            style={{
              background: "var(--primary)",
              color: "#fff",
              opacity: (isPHCustomer ? paymongoState.status === "loading" : paypalState.status === "loading") ? 0.7 : 1,
            }}
          >
            <CreditCard size={15} />{" "}
            {(isPHCustomer ? paymongoState.status : paypalState.status) === "loading" ? "Preparing checkout…" : "Pay now"}
          </button>
          <p className="text-[11px] text-center mt-2" style={{ color: "var(--ink-soft)" }}>
            {isPHCustomer
              ? `Accepts GCash, Maya, and local or international cards — checkout is created fresh for ${fmt(finalPrice)}, your exact discounted amount, so that's the only amount that will be deducted. Pay right here, you won't leave the app.`
              : paypalNeedsUsd
              ? `Pay securely via PayPal — PayPal doesn't settle in ${currencyCode}, so checkout is pre-filled for ${formatSubscriptionAmount(usdFinalPrice, "USD")} (your exact discounted amount converted to USD), created fresh and charged automatically.`
              : `Pay securely via PayPal — the checkout is pre-filled for ${fmt(finalPrice)}, your exact discounted amount, so that's the only amount that will be deducted.`}
          </p>
        </>
      )}

      <p className="text-[11px] text-center mt-5" style={{ color: "var(--ink-soft)" }}>
        Questions about billing? Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "var(--primary)" }}>{SUPPORT_EMAIL}</a>
      </p>

      {onClose === null && onLogOut && (
        <button
          onClick={onLogOut}
          className="w-full mt-3 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg"
          style={{ color: "var(--ink-soft)" }}
        >
          <LogOut size={12} /> Log out
        </button>
      )}
    </div>
  );

  // ---- In-app payment overlay ----
  // Renders the checkout (a freshly created PayMongo Payment Link for PHP
  // subscribers, a PayPal.me link for every other currency — see
  // isPHCustomer/payLink above) inside an embedded frame, on top of
  // everything else, so the owner pays without ever leaving the POS or
  // opening a new browser tab/site. Note: some hosted checkout pages block
  // being embedded this way for their own anti-clickjacking security (an
  // X-Frame-Options / CSP header the provider controls, not this app) — if
  // that ever happens the frame will just show blank/refuse to load, in
  // which case the "Open in a new tab instead" link below is the fallback.
  // A fully native in-app card form (no iframe/redirect at all, on either
  // provider) would need this same backend piece (see
  // api/create-paymongo-link.js / PAYMONGO_CREATE_LINK_ENDPOINT above) to
  // go further and handle Payment Methods/webhooks directly — the secret
  // key itself still could never live in this browser-side file either
  // way.
  const checkoutModal = showCheckout && (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(43,36,32,0.55)" }}
      onClick={() => setShowCheckout(false)}
    >
      <div
        className="rounded-2xl w-full max-w-md flex flex-col overflow-hidden shadow-xl"
        style={{ background: "var(--surface)", height: "min(680px, 85vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <CreditCard size={15} /> Secure payment
          </div>
          <button onClick={() => setShowCheckout(false)} className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg" style={{ color: "var(--ink-soft)" }}>
            <X size={14} /> Close
          </button>
        </div>
        <div className="flex-1 min-h-0" style={{ background: "#fff" }}>
          <iframe
            src={payLink}
            title="Payment checkout"
            className="w-full h-full"
            style={{ border: 0 }}
            allow="payment"
          />
        </div>
        <div className="px-4 py-2 text-center shrink-0" style={{ borderTop: "1px solid var(--line)" }}>
          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Not loading?{" "}
            <a href={payLink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--primary)" }}>
              Open in a new tab instead
            </a>
          </p>
        </div>
      </div>
    </div>
  );

  // onClose === null means this is a hard block (trial expired): render as
  // a full page, not a dismissable modal, so there's no way around it.
  if (onClose === null) {
    return (
      <div className="px-4 sm:px-6 pt-8 pb-16 max-w-6xl mx-auto">
        <div className="rounded-2xl border p-6 sm:p-8" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          {body}
        </div>
        {checkoutModal}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: "rgba(43,36,32,0.4)" }} onClick={onClose}>
      <div
        className="rounded-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto scrollbar-thin p-6"
        style={{ background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end -mt-2 -mr-2 mb-1">
          <button onClick={onClose} style={{ color: "var(--ink-soft)" }}><X size={16} /></button>
        </div>
        {body}
      </div>
      {checkoutModal}
    </div>
  );
}

// One-time gate shown automatically whenever a signed-in account has no
// business name saved on it yet (see the `!account?.businessName` check in
// the main App render). Normal sign-ups never hit this — signUp() already
// saves the name at account creation — this is only a catch-all for
// accounts that somehow ended up without one (an older row, one created
// outside the app's sign-up form, etc.). Saving here uses the exact same
// updateAccountField("businessName", …) path as the Business name field in
// Settings, so once it's filled in the app moves straight on into itself
// and this screen never appears again for that account.
function CompleteProfileView({ account, onSave, onLogOut }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Enter your business name to continue."); return; }
    setError("");
    setBusy(true);
    const ok = await onSave(trimmed);
    setBusy(false);
    if (ok === false) setError("Couldn't save — check your connection and try again.");
  };
  const onEnter = (e) => { if (e.key === "Enter") submit(); };

  return (
    <AuthCard>
      <div>
        <img src={LOGO_DATA_URL} alt="" className="h-14 w-auto mx-auto mb-4" style={{ objectFit: "contain" }} />
        <h1 className="display-font text-lg text-center mb-1" style={{ fontWeight: 600 }}>
          One last thing
        </h1>
        <p className="text-xs text-center mb-5" style={{ color: "var(--ink-soft)" }}>
          {account?.email ? `We're missing a business name for ${account.email}.` : "We're missing a business name for this account."} It'll show up on your receipts and dashboard.
        </p>
        <Field label="Business name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onEnter}
            placeholder="e.g. Sunrise Café"
            autoFocus
            className="w-full border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: "var(--line)" }}
          />
        </Field>
        {error && <p className="text-xs mt-3" style={{ color: "var(--alert)" }}>{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="w-full mt-5 py-2.5 rounded-lg text-sm font-medium"
          style={{ background: "var(--primary)", color: "#fff", opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Saving…" : "Continue"}
        </button>
        <button
          type="button"
          onClick={onLogOut}
          className="w-full mt-3 text-xs text-center"
          style={{ color: "var(--ink-soft)" }}
        >
          Log out instead
        </button>
      </div>
    </AuthCard>
  );
}

function SettingsView({ account, onUpdateField, onLogOut, onDeleteAccount, onUnsubscribe, trialInfo, currencyCode = "PHP", openUpgrade }) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  // Unsubscribe (cancel a PAID subscription without deleting the account —
  // see unsubscribeAccount() for what this does and doesn't touch) has its
  // own little confirm step, mirroring the Log out pattern above, since a
  // stray tap shouldn't immediately cut off access.
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);

  const copyCode = async () => {
    if (!account?.referralCode) return;
    try {
      await navigator.clipboard.writeText(account.referralCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard API unavailable — the code is still visible to copy by hand
    }
  };

  // Subscriber-only eligibility: the referral code, referral stats, and
  // billing/reward-credit breakdown below are only ever shown to an active,
  // PAYING subscriber (trialInfo.isSubscribed) — never during a free trial,
  // and never once a paid period has lapsed without renewing. This is what
  // "hide the code during a Free Trial" means in practice: the code itself
  // isn't rendered anywhere in the DOM below until this is true.
  const isSubscriber = !!trialInfo?.isSubscribed;
  const rewardCreditPercent = Math.min(account?.rewardCredits || 0, MAX_REWARD_CREDIT_PERCENT);
  const nextBillAmount = lockedSubscriptionPrice(currencyCode);
  const earnedCreditAmount = nextBillAmount * (rewardCreditPercent / 100);
  const updatedRemainingBill = nextBillAmount - earnedCreditAmount;
  const fmt = (n) => formatSubscriptionAmount(n, currencyCode);

  // ---- Pricing preview for a not-yet-subscribed owner ----
  // If they've already redeemed a referral code before paying, show the
  // "from → to" price (full price crossed out → discounted first-month
  // price) right here in Settings, not just after opening the Upgrade
  // popup. The 25% signup discount only ever applies to the FIRST month.
  const preSignupDiscountPercent = account?.discountPercent || 0;
  const preSignupDiscountAmount = nextBillAmount * (preSignupDiscountPercent / 100);
  const preSignupFinalPrice = nextBillAmount - preSignupDiscountAmount;

  return (
    <div className="max-w-md">
      <h2 className="display-font text-xl mb-1 flex items-center gap-2" style={{ fontWeight: 600 }}>
        <SettingsIcon size={18} /> Settings
      </h2>
      <p className="text-xs mb-5" style={{ color: "var(--ink-soft)" }}>
        Update your business details any time — changes save automatically as you type, no need to press anything.
      </p>

      <div className="rounded-xl border p-4 sm:p-5 space-y-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
        <div className="flex items-center gap-2 text-xs font-medium mb-1" style={{ color: "var(--ink-soft)" }}>
          <Store size={13} /> Business account
        </div>
        <AutoSaveField
          label="Business name"
          value={account?.businessName}
          onSave={(v) => onUpdateField("businessName", v)}
          placeholder="e.g. Sunrise Café"
          minLength={1}
        />
        <AutoSaveField
          label="Email"
          value={account?.email}
          onSave={(v) => onUpdateField("email", v)}
          placeholder="you@example.com"
          minLength={3}
        />
        <AutoSaveField
          label="Password"
          value=""
          type="password"
          onSave={(v) => onUpdateField("password", v)}
          placeholder="Leave blank to keep current password"
          minLength={6}
          helper="Type a new password to change it"
        />
      </div>

      {/* ---- Subscription status ---- */}
      <div className="rounded-xl border p-4 sm:p-5 mt-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Subscription</div>
          {trialInfo?.isSubscribed ? (
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: "#E4EFE7", color: "#2F6B45" }}>
              Active
            </span>
          ) : (
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: "#F3E3DC", color: "var(--alert)" }}>
              {account?.subscriptionStatus === "cancelled" ? "Unsubscribed" : trialInfo?.expired ? "Trial ended" : `${trialInfo?.daysLeft ?? ""} day${trialInfo?.daysLeft === 1 ? "" : "s"} left`}
            </span>
          )}
        </div>

        {/* ---- Unsubscribe — only offered to a currently-active, PAYING
            subscriber. Cancels the subscription but keeps the login (see
            unsubscribeAccount() for exactly what is and isn't touched). If
            this owner ever signs back up, they'll see the New Subscriber
            welcome flow (not a renewal), and any referral code they already
            redeemed stays permanently blocked from being redeemed again. ---- */}
        {trialInfo?.isSubscribed && (
          <div className="mt-3 pt-3" style={{ borderTop: "1px dashed var(--line)" }}>
            {!confirmUnsubscribe ? (
              <button
                onClick={() => setConfirmUnsubscribe(true)}
                className="flex items-center gap-1.5 text-[11px] px-3 py-2 rounded-lg border font-medium"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                <UserX size={12} /> Unsubscribe
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  This cancels your paid subscription right away — your POS locks behind the paywall again. Your login and data stay put, and you can resubscribe any time.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={unsubscribing}
                    onClick={async () => {
                      setUnsubscribing(true);
                      const ok = await onUnsubscribe();
                      setUnsubscribing(false);
                      if (ok) setConfirmUnsubscribe(false);
                    }}
                    className="flex items-center gap-1.5 text-[11px] px-3 py-2 rounded-lg font-medium disabled:opacity-40"
                    style={{ background: "var(--alert)", color: "#fff" }}
                  >
                    <UserX size={12} /> {unsubscribing ? "Unsubscribing…" : "Confirm unsubscribe"}
                  </button>
                  <button
                    onClick={() => setConfirmUnsubscribe(false)}
                    className="text-[11px] px-3 py-2 rounded-lg border"
                    style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {!trialInfo?.isSubscribed && (
          <>
            {/* ---- Monthly fee preview — shown right here as soon as the
                owner is looking at the upgrade option, in their chosen
                currency. If a referral code was already applied, this shows
                the "from → to" price so the discount is obvious before they
                even open the Subscribe screen. ---- */}
            <div className="rounded-lg p-3 mt-3" style={{ background: "var(--bg)" }}>
              {preSignupDiscountPercent > 0 ? (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span style={{ color: "var(--ink-soft)" }}>Monthly fee</span>
                    <span className="line-through" style={{ color: "var(--ink-soft)" }}>{fmt(nextBillAmount)}/mo</span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span style={{ color: "#2F6B45" }}>Referral discount ({preSignupDiscountPercent}% off, first month only)</span>
                    <span style={{ color: "#2F6B45" }}>−{fmt(preSignupDiscountAmount)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm font-semibold mt-2 pt-2" style={{ borderTop: "1px dashed var(--line)" }}>
                    <span>Your first month</span>
                    <span>{fmt(preSignupFinalPrice)}<span className="text-xs font-normal">/mo</span></span>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between text-sm">
                  <span style={{ color: "var(--ink-soft)" }}>Monthly fee</span>
                  <span className="font-semibold">{fmt(nextBillAmount)}<span className="text-xs font-normal" style={{ color: "var(--ink-soft)" }}>/mo</span></span>
                </div>
              )}
            </div>
            <button
              onClick={openUpgrade}
              className="w-full mt-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: "var(--primary)", color: "#fff" }}
            >
              Upgrade now — {fmt(preSignupDiscountPercent > 0 ? preSignupFinalPrice : nextBillAmount)}/mo
            </button>
          </>
        )}
      </div>

      {/* ---- Referral code & rewards ----
          Hidden entirely while on a Free Trial (or a lapsed/expired paid
          period) — no code, no stats, no credit — until the account is an
          active, paying subscriber. */}
      {isSubscriber ? (
        <div className="rounded-xl border p-4 sm:p-5 mt-4 space-y-3" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Your referral code</div>
          <div className="flex items-center gap-2">
            <div
              className="flex-1 text-center tracking-widest font-semibold text-sm py-2 rounded-lg border"
              style={{ borderColor: "var(--line)", background: "var(--bg)", letterSpacing: "0.15em" }}
            >
              {account?.referralCode || "—"}
            </div>
            <button
              onClick={copyCode}
              className="text-xs px-3 py-2 rounded-lg border"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
            Share this code — new sign-ups who use it get {REFERRAL_DISCOUNT_PERCENT}% off their first month, and you earn a {REFERRAL_REWARD_PERCENT}% reward credit every time it's used (up to {MAX_REWARD_CREDIT_PERCENT}% off in one billing month).
          </p>

          {/* ---- Current-month referral explainer ---- */}
          <div className="rounded-lg p-3" style={{ background: "var(--bg)" }}>
            <div className="text-[11px] font-medium mb-1">Current month</div>
            <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Every time a new user signs up with your referral code, you earn {REFERRAL_REWARD_PERCENT}% off your immediate current billing cycle, up to a maximum of {MAX_REWARD_CREDIT_PERCENT}% off. When the month ends and the next billing cycle begins, that discount resets to 0% for the new month until fresh referrals are made during that cycle.
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <div className="flex-1 rounded-lg p-3 text-center" style={{ background: "var(--bg)" }}>
              <div className="text-lg font-semibold" style={{ fontFamily: "var(--display-font, inherit)" }}>{account?.referralCount || 0}</div>
              <div className="text-[10px]" style={{ color: "var(--ink-soft)" }}>Referrals</div>
            </div>
            <div className="flex-1 rounded-lg p-3 text-center" style={{ background: "var(--bg)" }}>
              <div className="text-lg font-semibold">{rewardCreditPercent}%</div>
              <div className="text-[10px]" style={{ color: "var(--ink-soft)" }}>Reward credit</div>
            </div>
            <div className="flex-1 rounded-lg p-3 text-center" style={{ background: "var(--bg)" }}>
              <div className="text-lg font-semibold">{account?.discountPercent || 0}%</div>
              <div className="text-[10px]" style={{ color: "var(--ink-soft)" }}>Your discount</div>
            </div>
          </div>

          {/* ---- Bill balance breakdown — Next Bill Amount, Earned Reward
              Credits, and the Updated Remaining Bill Amount after applying
              those credits, in the subscriber's chosen currency. ---- */}
          <div className="rounded-lg p-3 mt-1" style={{ background: "var(--bg)" }}>
            <div className="text-[11px] font-medium mb-2" style={{ color: "var(--ink-soft)" }}>Your next bill</div>
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: "var(--ink-soft)" }}>Next bill amount</span>
              <span>{fmt(nextBillAmount)}</span>
            </div>
            {rewardCreditPercent > 0 && (
              <div className="flex items-center justify-between text-xs mt-1">
                <span style={{ color: "#2F6B45" }}>Earned reward credits ({rewardCreditPercent}%)</span>
                <span style={{ color: "#2F6B45" }}>−{fmt(earnedCreditAmount)}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm font-semibold mt-2 pt-2" style={{ borderTop: "1px dashed var(--line)" }}>
              <span>Updated remaining bill</span>
              <span>{fmt(updatedRemainingBill)}</span>
            </div>
            {/* ---- Explicit note once the reward credit has hit the 50%
                safety cap, so it's visible right on the bill itself and
                not just in the general explainer text above. ---- */}
            {rewardCreditPercent >= MAX_REWARD_CREDIT_PERCENT && (
              <p className="text-[10px] mt-2 pt-2" style={{ color: "var(--primary-dark)", borderTop: "1px dashed var(--line)" }}>
                You've reached the maximum reward credit ({MAX_REWARD_CREDIT_PERCENT}% off) for this billing cycle. Additional referrals this month won't reduce your bill further — the cap resets to 0% at the start of your next cycle.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border p-4 sm:p-5 mt-4" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
            <Store size={13} /> Referral code
          </div>
          <p className="text-[11px] mt-2" style={{ color: "var(--ink-soft)" }}>
            Your referral code unlocks once you're a paying subscriber — subscribe to get your own code to share, and start earning a {REFERRAL_REWARD_PERCENT}% reward credit every time it's used, up to a maximum of {MAX_REWARD_CREDIT_PERCENT}% off any single bill. New users who sign up with your code get {REFERRAL_DISCOUNT_PERCENT}% off their first month.
          </p>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between flex-wrap gap-3">
        {confirmLogout ? (
          <div className="flex items-center gap-2">
            <button
              onClick={onLogOut}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-medium"
              style={{ background: "var(--alert)", color: "#fff" }}
            >
              <LogOut size={13} /> Confirm log out
            </button>
            <button
              onClick={() => setConfirmLogout(false)}
              className="text-xs px-3 py-2 rounded-lg border"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmLogout(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border"
            style={{ borderColor: "var(--line)", color: "var(--alert)" }}
          >
            <LogOut size={13} /> Log out
          </button>
        )}
        <p className="text-[11px] flex items-center gap-3" style={{ color: "var(--ink-soft)" }}>
          <span>
            Need help? <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "var(--primary)" }}>{SUPPORT_EMAIL}</a>
          </span>
          <TermsGuidelinesButton />
        </p>
      </div>

      {/* ---- Danger zone: permanent account deletion ---- */}
      <div className="rounded-xl border p-4 sm:p-5 mt-4" style={{ borderColor: "var(--alert)", background: "var(--surface)" }}>
        <div className="text-xs font-medium mb-1" style={{ color: "var(--alert)" }}>Danger zone</div>
        {!showDeleteConfirm ? (
          <>
            <p className="text-[11px] mb-3" style={{ color: "var(--ink-soft)" }}>
              Permanently delete your owner account and cloud subscription record. This can't be undone.
            </p>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="text-xs px-3 py-2 rounded-lg border font-medium"
              style={{ borderColor: "var(--alert)", color: "var(--alert)" }}
            >
              Delete account
            </button>
          </>
        ) : (
          <div className="space-y-2.5">
            <p className="text-[11px]" style={{ color: "var(--alert)" }}>
              This will permanently delete your login and business account. Sales, catalog, and other data stored on this device are not affected. Type <b>DELETE</b> to confirm.
            </p>
            <input
              type="text"
              value={deleteTyped}
              onChange={(e) => setDeleteTyped(e.target.value)}
              placeholder="Type DELETE"
              className="w-full p-2.5 text-sm rounded-lg border"
              style={{ borderColor: "var(--line)", background: "var(--bg)" }}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                disabled={deleteTyped.trim() !== "DELETE" || deleting}
                onClick={async () => {
                  setDeleting(true);
                  const ok = await onDeleteAccount();
                  setDeleting(false);
                  if (!ok) { setShowDeleteConfirm(false); setDeleteTyped(""); }
                }}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-medium disabled:opacity-40"
                style={{ background: "var(--alert)", color: "#fff" }}
              >
                <Trash2 size={13} /> {deleting ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeleteTyped(""); }}
                className="text-xs px-3 py-2 rounded-lg border"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// EMBEDDED NUMERIC KEYPAD (built into the checkout layout, not a popup)
// =============================================================================
// Used wherever a cashier keys in "Amount Received" — the POS checkout
// panel and the Settle Tab screen. It's a plain in-line grid of buttons
// sitting right under the amount field, not a modal, so it works well on
// touchscreen registers that have no physical numpad and don't want a
// popup covering the total/change readout while typing.
//
// `value` is the current amount as a string (same shape the linked text
// input uses); `onChange` receives the next string. Digit entry mirrors
// how a calculator/POS numpad behaves: leading zero is replaced by the
// first digit typed, and only one decimal point is allowed.
function NumericKeypad({ value, onChange }) {
  const press = (key) => {
    if (key === "back") {
      onChange((value || "").slice(0, -1));
      return;
    }
    if (key === "clear") {
      onChange("");
      return;
    }
    if (key === ".") {
      if ((value || "").includes(".")) return; // only one decimal point
      onChange(value === "" ? "0." : value + ".");
      return;
    }
    // Digit key
    if (value === "" || value === "0") {
      onChange(key);
    } else {
      onChange(value + key);
    }
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"];

  return (
    <div className="grid grid-cols-3 gap-1.5 mt-1.5" role="group" aria-label="Numeric keypad">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => press(k)}
          className="py-2 rounded-lg text-sm font-medium border active:scale-95"
          style={{ borderColor: "var(--line)", background: "var(--bg)", color: "var(--ink)" }}
        >
          {k === "back" ? <X size={14} className="mx-auto" /> : k}
        </button>
      ))}
      <button
        type="button"
        onClick={() => press("clear")}
        className="col-span-3 py-1.5 rounded-lg text-[11px] font-medium border"
        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
      >
        Clear
      </button>
    </div>
  );
}

function ModalWrap({ onClose, children }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: "rgba(43,36,32,0.4)" }} onClick={onClose}>
      <div className="rounded-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto scrollbar-thin" style={{ background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// =============================================================================
// TERMS & GUIDELINES (short, in-app version)
// =============================================================================
// A condensed, plain-language summary meant to be read on a phone screen in
// under a minute — NOT a replacement for a full legal Terms of Service. Keep
// this in sync with the full document if the underlying rules ever change
// (trial length, referral percentages, retention window, etc.).
function TermsGuidelinesModal({ onClose }) {
  const Section = ({ title, children }) => (
    <div className="mb-4">
      <div className="text-xs font-semibold mb-1.5">{title}</div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
  const Point = ({ children }) => (
    <li className="text-[12px] leading-relaxed flex gap-1.5" style={{ color: "var(--ink-soft)" }}>
      <span style={{ color: "var(--primary)" }}>•</span>
      <span>{children}</span>
    </li>
  );

  return (
    <ModalWrap onClose={onClose}>
      <div className="p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileText size={16} /> Terms & Guidelines
          </div>
          <button onClick={onClose} className="p-1 rounded-full" style={{ color: "var(--ink-soft)" }} title="Close">
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] mb-4" style={{ color: "var(--ink-soft)" }}>
          The short version. Full terms available on request.
        </p>

        <Section title="Trial & subscription">
          <Point>New accounts get a {TRIAL_DAYS}-day free trial.</Point>
          <Point>Subscription price is fixed in the currency you pick at sign-up — it can't be changed later.</Point>
          <Point>Subscriptions run in {SUBSCRIPTION_PERIOD_DAYS}-day periods; renew from Settings before yours lapses.</Point>
          <Point>Fees aren't refundable.</Point>
        </Section>

        <Section title="Your data">
          <Point>Your catalog, sales, staff, shifts, and waste logs are stored on this device's browser only — not synced to the cloud or other devices.</Point>
          <Point>Clearing browser data, losing the device, or switching devices can permanently lose that data. Back it up if you need to keep it.</Point>
          <Point>Sales history older than {RETENTION_MONTHS} months is purged automatically.</Point>
          <Point>Deleting your account removes your login, not this device's local data.</Point>
        </Section>

        <Section title="Staying logged in">
          <Point>Removing the app icon does NOT log you out — use Log out in Settings, or clear browser data, to actually sign out.</Point>
          <Point>You're responsible for any staff PINs you issue and what happens under them.</Point>
        </Section>

        <Section title="Referrals">
          <Point>Your code gives new sign-ups {REFERRAL_DISCOUNT_PERCENT}% off their first month.</Point>
          <Point>You earn {REFERRAL_REWARD_PERCENT}% credit per referral, capped at {MAX_REWARD_CREDIT_PERCENT}% off, resetting each billing cycle.</Point>
          <Point>Fake or self-referrals aren't allowed and may get an account suspended.</Point>
        </Section>

        <Section title="Fair use">
          <Point>Use the app for legitimate business purposes only — no unauthorized access, tampering, or fraud.</Point>
          <Point>We can suspend accounts that violate these terms or abuse the referral program.</Point>
        </Section>

        <p className="text-[11px] mt-1" style={{ color: "var(--ink-soft)" }}>
          Questions? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "var(--primary)" }}>{SUPPORT_EMAIL}</a>
        </p>

        <a
          href={TERMS_DOCX_DATA_URL}
          download="OpSteward-Terms-and-Guidelines.docx"
          className="flex items-center justify-center gap-1.5 w-full mt-3 text-xs px-3 py-2.5 rounded-lg border font-medium"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        >
          <Download size={13} /> Download full terms (.docx)
        </a>

        <button
          onClick={onClose}
          className="w-full mt-2 text-xs px-3 py-2.5 rounded-lg font-medium"
          style={{ background: "var(--primary)", color: "#fff" }}
        >
          Got it
        </button>
      </div>
    </ModalWrap>
  );
}

function TermsGuidelinesButton({ className }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className || "flex items-center gap-1 text-[11px] underline"}
        style={{ color: "var(--ink-soft)" }}
      >
        <FileText size={11} /> Terms & Guidelines
      </button>
      {open && <TermsGuidelinesModal onClose={() => setOpen(false)} />}
    </>
  );
}

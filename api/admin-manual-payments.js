// =============================================================================
// ADMIN MANUAL-PAYMENT REVIEW — api/admin-manual-payments.js
// =============================================================================
// This is the backend for public/admin.html. It does three things:
//
//   1. GET  -> lists every business currently sitting with
//              manual_payment_status = 'pending' (i.e. someone typed in a
//              GCash/bank/PayPal.me reference and is waiting for you to
//              check it against your GCash/bank/PayPal dashboard).
//
//   2. POST { action: "approve" } -> calls activate_subscription() in
//      Supabase (the SAME function your PayPal webhook calls), which is the
//      only thing that's allowed to flip subscription_status to 'active'.
//      Right after that succeeds, this function emails the customer
//      "You're activated!" via Gmail.
//
//   3. POST { action: "reject" } -> calls reject_manual_payment(), which
//      sets manual_payment_status = 'rejected' (this flips their Upgrade
//      screen back to a resubmit form). Right after, this function emails
//      the customer "we couldn't verify that" via Gmail.
//
// WHY THIS HAS TO BE A SERVERLESS FUNCTION, NOT BROWSER CODE:
// Approving/rejecting uses your SUPABASE_SERVICE_ROLE_KEY, which can bypass
// every safety rule your database has (Row Level Security, the "only your
// own row" restrictions, etc). That key must never be sent to a browser —
// not even yours. It only ever lives here, on the server, and only this
// server-side code can read it (via process.env).
//
// -----------------------------------------------------------------------------
// ONE-TIME SETUP (about 10 minutes)
// -----------------------------------------------------------------------------
//   1. Install the one new dependency this file needs:
//        npm install nodemailer
//
//   2. Turn on Gmail's "App Passwords" for the Gmail inbox you want to send
//      customer emails from (this can be the same address as SUPPORT_EMAIL
//      in App.jsx, or a different one — up to you):
//        a. Go to https://myaccount.google.com/security
//        b. Turn on 2-Step Verification if it isn't already on (App
//           Passwords require it).
//        c. Go to https://myaccount.google.com/apppasswords
//        d. Create a new app password (name it anything, e.g. "OpSteward").
//           Google gives you a 16-character code like "abcd efgh ijkl mnop".
//           Copy it WITHOUT the spaces.
//
//   3. In Vercel -> your project -> Settings -> Environment Variables, add
//      three new ones (same screen as PAYPAL_CLIENT_ID etc):
//        GMAIL_USER          -> the Gmail address from step 2, e.g.
//                               opsteward.pos@gmail.com
//        GMAIL_APP_PASSWORD  -> the 16-character code from step 2, no spaces
//        ADMIN_SECRET        -> a password YOU make up, used to protect this
//                               endpoint and public/admin.html so a stranger
//                               who finds the URL can't approve/reject
//                               anyone's payment. Make it long and random —
//                               e.g. generate one at
//                               https://1password.com/password-generator
//                               and treat it like your Supabase service
//                               role key: never share it, never commit it.
//
//   4. Redeploy (Vercel -> Deployments -> ... -> Redeploy), so the new env
//      vars actually take effect.
//
//   5. Open https://<your-app-domain>/admin.html, enter the ADMIN_SECRET
//      you made up in step 3, and you should see any pending manual
//      payments waiting for review.
//
// IMPORTANT — GMAIL SENDING LIMITS: a free Gmail account can send up to
// 500 emails/day, which is almost certainly more than enough for a single
// café's approve/reject volume. If Gmail ever throttles or flags the
// account (rare, but can happen if many recipients mark mail as spam),
// this same inbox is used for your other notify_owner() alerts too — so if
// emails from the app suddenly stop arriving anywhere, check
// https://myaccount.google.com/security for a warning from Google first.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

// Service-role client: this bypasses Row Level Security entirely, which is
// exactly why it must only ever be constructed here (server-side), never
// shipped to a browser. See the big comment block at the top of this file.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// One shared Gmail transporter, reused across requests. `service: "gmail"`
// tells nodemailer to use Gmail's known SMTP host/port automatically — you
// only have to supply the address + app password.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

const SUPPORT_EMAIL = process.env.GMAIL_USER || "opsteward.support@gmail.com";

// Kept in one place so it's easy to update if SUBSCRIPTION_PERIOD_DAYS ever
// changes in App.jsx — this MUST match the "interval '30 days'" hard-coded
// inside activate_subscription() in your Supabase SQL, since that's what
// actually sets subscription_period_end. This constant is only used to
// describe that same date back to the customer in the email — it doesn't
// control anything in the database itself.
const SUBSCRIPTION_PERIOD_DAYS = 30;

// Mirrors LOCKED_SUBSCRIPTION_PRICE_PHP / CURRENCIES in App.jsx exactly — if
// you ever change a price or add a currency there, update it here too, or
// the amount shown on a pending card will drift from what the customer
// actually saw on the Upgrade screen.
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

const CURRENCIES = {
  PHP: { symbol: "₱" },
  USD: { symbol: "$" },
  EUR: { symbol: "€" },
  GBP: { symbol: "£" },
  JPY: { symbol: "¥", zeroDecimal: true },
  AUD: { symbol: "A$" },
  SGD: { symbol: "S$" },
  MYR: { symbol: "RM" },
  INR: { symbol: "₹" },
  IDR: { symbol: "Rp", zeroDecimal: true },
  THB: { symbol: "฿" },
  VND: { symbol: "₫", zeroDecimal: true },
};

function formatExpectedAmount(currencyCode, discountPercent) {
  const code = currencyCode || "PHP";
  const full = LOCKED_SUBSCRIPTION_PRICE_PHP[code] ?? LOCKED_SUBSCRIPTION_PRICE_PHP.PHP;
  const cur = CURRENCIES[code] || CURRENCIES.PHP;
  const final = full - full * ((Number(discountPercent) || 0) / 100);
  const decimals = cur.zeroDecimal ? 0 : 2;
  const formatted = final.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${cur.symbol}${formatted}`;
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

async function sendActivationEmail({ to, businessName }) {
  const renewalDate = new Date(Date.now() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const greetName = businessName ? businessName : "there";

  await transporter.sendMail({
    from: `OpSteward <${process.env.GMAIL_USER}>`,
    to,
    subject: "✅ Your subscription is active",
    html: `
      <p>Hi ${greetName},</p>
      <p>Good news — we've verified your payment and your OpSteward subscription is now <b>active</b>.</p>
      <p>Your next renewal is due on <b>${formatDate(renewalDate)}</b>.</p>
      <p>You can log back in and pick up right where you left off.</p>
      <p>Questions? Just reply to this email, or reach us at ${SUPPORT_EMAIL}.</p>
      <p>— OpSteward</p>
    `,
  });
}

async function sendRejectionEmail({ to, businessName }) {
  const greetName = businessName ? businessName : "there";

  await transporter.sendMail({
    from: `OpSteward <${process.env.GMAIL_USER}>`,
    to,
    subject: "⚠️ We couldn't verify your payment reference",
    html: `
      <p>Hi ${greetName},</p>
      <p>We checked the payment reference you submitted but couldn't match it against a confirmed payment.</p>
      <p>This usually means the reference number had a typo, or the payment hasn't fully gone through yet on your bank/GCash/PayPal's side.</p>
      <p>Please double-check the reference and resubmit it from the Upgrade screen in the app. If you're sure the payment went through and this still doesn't work, reply to this email and we'll sort it out.</p>
      <p>— OpSteward</p>
    `,
  });
}

// Very small shared-secret gate. This is intentionally simple (no user
// accounts, no sessions) because it's protecting a single-admin tool, not a
// multi-user product — but it's still required on every request, GET or
// POST, so nobody can hit this URL and see or act on customer data without
// knowing ADMIN_SECRET.
function isAuthorized(req) {
  const provided =
    req.method === "GET"
      ? req.query.secret
      : (req.body && req.body.secret);
  return (
    typeof provided === "string" &&
    typeof process.env.ADMIN_SECRET === "string" &&
    process.env.ADMIN_SECRET.length > 0 &&
    provided === process.env.ADMIN_SECRET
  );
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Not authorized." });
    return;
  }

  if (req.method === "GET") {
    // Pending: the live, current state — straight from businesses.
    const { data: pending, error: pendingError } = await supabaseAdmin
      .from("businesses")
      .select("id, business_name, email, payment_reference, manual_payment_submitted_at, currency_code, discount_percent")
      .eq("manual_payment_status", "pending")
      .order("manual_payment_submitted_at", { ascending: true });

    if (pendingError) {
      res.status(500).json({ error: pendingError.message });
      return;
    }

    // History: past decisions, from the permanent log table (see
    // setup-manual-payment-history.sql) since businesses itself gets reset
    // back to a clean slate after each decision. Most recent first, capped
    // at 100 so this stays fast as the log grows.
    const { data: history, error: historyError } = await supabaseAdmin
      .from("manual_payment_reviews")
      .select("id, business_id, business_name, email, reference, action, reviewed_at")
      .order("reviewed_at", { ascending: false })
      .limit(100);

    if (historyError) {
      res.status(500).json({ error: historyError.message });
      return;
    }

    // Duplicate-reference check: flags a reference that's either used by
    // more than one pending row right now, or matches a reference that was
    // already approved before for ANY business. Either case is worth a
    // second look before you approve — the first catches two people
    // submitting the same screenshot/reference, the second catches someone
    // reusing a reference that already paid out once.
    const referenceCounts = new Map();
    pending.forEach((biz) => {
      const ref = (biz.payment_reference || "").trim().toLowerCase();
      if (!ref) return;
      referenceCounts.set(ref, (referenceCounts.get(ref) || 0) + 1);
    });
    const approvedReferences = new Set(
      history
        .filter((h) => h.action === "approved")
        .map((h) => (h.reference || "").trim().toLowerCase())
        .filter(Boolean)
    );

    const pendingWithFlags = pending.map((biz) => {
      const ref = (biz.payment_reference || "").trim().toLowerCase();
      const isDuplicatePending = ref && referenceCounts.get(ref) > 1;
      const wasAlreadyApproved = ref && approvedReferences.has(ref);
      return {
        ...biz,
        expectedAmount: formatExpectedAmount(biz.currency_code, biz.discount_percent),
        duplicateWarning: isDuplicatePending
          ? "This exact reference was also submitted by another pending account."
          : wasAlreadyApproved
          ? "This exact reference was already approved once before."
          : null,
      };
    });

    res.status(200).json({ pending: pendingWithFlags, history });
    return;
  }

  if (req.method === "POST") {
    const { businessId, action, reference } = req.body || {};

    if (!businessId || (action !== "approve" && action !== "reject")) {
      res.status(400).json({ error: "businessId and a valid action ('approve' or 'reject') are required." });
      return;
    }

    // Look the business up first so we know who/where to email, and so we
    // can fall back to the reference they originally submitted if the
    // admin didn't type a different one in on the approve form.
    const { data: business, error: fetchError } = await supabaseAdmin
      .from("businesses")
      .select("id, business_name, email, payment_reference, manual_payment_status")
      .eq("id", businessId)
      .single();

    if (fetchError || !business) {
      res.status(404).json({ error: "Business not found." });
      return;
    }

    if (business.manual_payment_status !== "pending") {
      res.status(409).json({ error: "This payment has already been reviewed." });
      return;
    }

    try {
      if (action === "approve") {
        const finalReference = (reference && reference.trim()) || business.payment_reference;

        const { error: rpcError } = await supabaseAdmin.rpc("activate_subscription", {
          p_business_id: businessId,
          p_reference: finalReference,
        });
        if (rpcError) throw rpcError;

        // Record this decision permanently — see setup-manual-payment-history.sql
        // for why this can't just be read back off the businesses row later.
        // A failure here is logged but never blocks the response: the
        // activation already succeeded, and the customer's active account
        // matters more than the history log being perfectly complete.
        await supabaseAdmin.from("manual_payment_reviews").insert({
          business_id: businessId,
          business_name: business.business_name,
          email: business.email,
          reference: finalReference,
          action: "approved",
        });

        // Email sending failures deliberately do NOT roll back the
        // activation above — the customer's account being active is the
        // important part; a failed email is annoying but recoverable
        // (you can always tell them by hand), whereas silently leaving a
        // paying customer's account inactive because Gmail hiccuped would
        // be worse.
        try {
          await sendActivationEmail({ to: business.email, businessName: business.business_name });
        } catch (emailError) {
          res.status(200).json({
            ok: true,
            emailSent: false,
            emailError: emailError.message,
          });
          return;
        }

        res.status(200).json({ ok: true, emailSent: true });
        return;
      }

      // action === "reject"
      const { error: rpcError } = await supabaseAdmin.rpc("reject_manual_payment", {
        p_business_id: businessId,
      });
      if (rpcError) throw rpcError;

      await supabaseAdmin.from("manual_payment_reviews").insert({
        business_id: businessId,
        business_name: business.business_name,
        email: business.email,
        reference: business.payment_reference,
        action: "rejected",
      });

      try {
        await sendRejectionEmail({ to: business.email, businessName: business.business_name });
      } catch (emailError) {
        res.status(200).json({
          ok: true,
          emailSent: false,
          emailError: emailError.message,
        });
        return;
      }

      res.status(200).json({ ok: true, emailSent: true });
      return;
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    }
  }

  res.status(405).json({ error: "Method not allowed." });
}

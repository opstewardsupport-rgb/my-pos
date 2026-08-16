// =============================================================================
// api/create-paymongo-link.js — Vercel serverless function
// =============================================================================
// Called by the app (startPayMongoCheckout() in cafe-pos.jsx) the moment a
// PH subscriber clicks "Pay now". Creates a brand-new PayMongo Checkout
// Session priced at the EXACT peso amount shown on screen, tags it with
// businessId (so the webhook — api/paymongo-webhook.js — knows whose
// account to reactivate once it's paid), and hands back the checkout URL.
//
// FREE (₱0) RENEWALS: PayMongo can't create a checkout session for ₱0 at
// all — no payment processor supports charging nothing. So when a
// subscriber's discount (referral signup discount, or accumulated
// reward-credit — see MAX_REWARD_CREDIT_PERCENT in cafe-pos.jsx, which can
// now reach 100%) brings the price down to exactly ₱0, this function skips
// PayMongo entirely and activates the subscription directly, the same way
// api/paymongo-webhook.js does after a real payment. The app (see
// startPayMongoCheckout() in cafe-pos.jsx) checks for `activated: true` in
// the response and, if present, treats it as an immediate successful
// "payment" — no popup, no checkout page, nothing to redirect to.
//
// ONE-TIME SETUP (Vercel → your project → Settings → Environment Variables):
//   PAYMONGO_SECRET_KEY = your PayMongo secret key (sk_test_... while
//   testing, sk_live_... for real charges). PayMongo Dashboard →
//   Developers → API Keys.
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — only needed for the ₱0 free-
//   renewal path above. These are the SAME two values already set up for
//   api/paymongo-webhook.js (Supabase dashboard → Settings → API →
//   "service_role" key), so if that webhook is already working, nothing
//   new to add here — this function just reads the same env vars.
//
// This file must never run in the browser — it's the one place your secret
// key is allowed to exist, because only Vercel's servers can read
// process.env here.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { amountPhp, description, businessId } = req.body || {};

  const amount = Number(amountPhp);
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: "amountPhp must be a non-negative number." });
    return;
  }
  if (!businessId) {
    res.status(400).json({ error: "businessId is required." });
    return;
  }

  // ---- FREE RENEWAL PATH: price rounds to exactly ₱0 ----
  // Rounded to the nearest centavo before comparing, so e.g. 0.001 (a
  // rounding artifact, not a genuine free renewal) still goes through
  // PayMongo rather than silently activating for free.
  const amountCentavos = Math.round(amount * 100);
  if (amountCentavos === 0) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      res.status(500).json({
        error:
          "This subscriber's discount brings the price to ₱0, but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set on the server, so it can't be auto-activated.",
      });
      return;
    }
    try {
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
      const { error } = await supabaseAdmin.rpc("activate_subscription_for_business", {
        p_business_id: businessId,
        p_reference: "FREE_100_PERCENT_DISCOUNT",
      });
      if (error) {
        console.error("create-paymongo-link: free-renewal activation failed:", error);
        res.status(500).json({ error: "Couldn't activate the free renewal just now." });
        return;
      }
      res.status(200).json({ activated: true });
      return;
    } catch (err) {
      console.error("create-paymongo-link: free-renewal activation threw:", err);
      res.status(500).json({ error: "Couldn't activate the free renewal just now." });
      return;
    }
  }

  // ---- NORMAL PAID PATH: everything below is unchanged ----
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: "PAYMONGO_SECRET_KEY is not set on the server." });
    return;
  }

  // Where PayMongo sends the subscriber back to after paying (or
  // cancelling). Falls back to wherever this request came from, so you
  // don't have to hard-code your domain here.
  const origin =
    process.env.APP_URL ||
    (req.headers.origin ? req.headers.origin : `https://${req.headers.host}`);

  try {
    const resp = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // PayMongo uses HTTP Basic auth: secret key as the username, empty
        // password. This exact base64 pattern is straight from their docs.
        Authorization: "Basic " + Buffer.from(`${secretKey}:`).toString("base64"),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            description: description || "Subscription payment",
            line_items: [
              {
                currency: "PHP",
                amount: amountCentavos,
                name: description || "Subscription payment",
                quantity: 1,
              },
            ],
            // GCash + Maya + cards — the PH payment methods your café
            // owners actually use. Add/remove codes here if you want to
            // offer more (e.g. "grab_pay", "billease").
            payment_method_types: ["gcash", "paymaya", "card"],
            // Ties this specific checkout back to one business account.
            // This is what the webhook reads to know whose account to
            // reactivate — see api/paymongo-webhook.js.
            metadata: { business_id: businessId },
            reference_number: String(businessId).replace(/-/g, "").slice(0, 50),
            success_url: origin,
            cancel_url: origin,
          },
        },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      const message = data?.errors?.[0]?.detail || "PayMongo rejected the request.";
      res.status(resp.status).json({ error: message });
      return;
    }

    const checkoutUrl = data?.data?.attributes?.checkout_url;
    if (!checkoutUrl) {
      res.status(502).json({ error: "PayMongo didn't return a checkout URL." });
      return;
    }

    res.status(200).json({ url: checkoutUrl });
  } catch (err) {
    console.error("create-paymongo-link failed:", err);
    res.status(500).json({ error: "Couldn't reach PayMongo just now." });
  }
}

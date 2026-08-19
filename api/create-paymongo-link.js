// =============================================================================
// api/create-paymongo-link.js — Vercel serverless function (SECURITY FIX)
// =============================================================================
// WHAT CHANGED AND WHY
// ---------------------------------------------------------------------------
// The old version trusted `amountPhp` and `businessId` straight from the
// browser's request body. That meant:
//   1. Anyone could send { amountPhp: 0, businessId: "<any account id>" }
//      and get that account instantly activated — no PayMongo, no payment,
//      no login required at all.
//   2. Even a real payment could be created for any amount the caller
//      typed (e.g. ₱1 instead of ₱1,699), and the webhook would have no
//      way of knowing that was wrong, since it just confirms "was this
//      PayMongo checkout session paid," not "was it paid the right amount."
//
// THE FIX: never trust the browser for WHO is paying or HOW MUCH.
//   - WHO: read the Supabase login token sent in the Authorization header,
//     and ask Supabase itself who that token belongs to. The business id
//     used everywhere below comes from THAT, never from req.body.
//   - HOW MUCH: look up that business's own discount_percent /
//     reward_credits / subscription_status / currency_code from the
//     database, then compute the price the exact same way the app itself
//     does. The browser can no longer say "charge me less" or "charge me
//     nothing" — the server decides the price on its own.
//
// ACTION NEEDED FROM YOU: the constant MAX_REWARD_CREDIT_PERCENT below is
// set to 100 as a safe default (a subscriber can never be charged less
// than ₱0, so 100 can't be "too low" and cause an overcharge). But please
// open cafe-pos.jsx, search for MAX_REWARD_CREDIT_PERCENT, and if it's set
// to something OTHER than 100 there, change the value below to match
// exactly — otherwise a renewal discount could compute slightly
// differently here than what the subscriber was shown on screen.
//
// Everything else (PayMongo checkout creation, the ₱0 free-activation
// path) works the same as before — it's just fed numbers the server
// computed itself instead of numbers the browser handed it.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- Pricing table — must match LOCKED_SUBSCRIPTION_PRICE_PHP in
// cafe-pos.jsx exactly. If you ever add a currency or change a price
// there, update it here too. ----
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
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "IDR", "VND"]);

// See "ACTION NEEDED FROM YOU" above.
const MAX_REWARD_CREDIT_PERCENT = 100;

function computePriceForBusiness(business, currencyCode) {
  const code = LOCKED_SUBSCRIPTION_PRICE_PHP[currencyCode] !== undefined ? currencyCode : "PHP";
  const fullPrice = LOCKED_SUBSCRIPTION_PRICE_PHP[code];

  const hasSubscribedBefore = business.subscription_status === "active";
  const rewardCreditPercent = Math.min(Number(business.reward_credits) || 0, MAX_REWARD_CREDIT_PERCENT);
  const signupDiscountPercent = Number(business.discount_percent) || 0;
  const discountPercent = hasSubscribedBefore ? rewardCreditPercent : signupDiscountPercent;

  const rawFinal = fullPrice * (1 - discountPercent / 100);
  // Round the same way the PHP centavo amount is rounded below, so the
  // number we compare against ₱0 matches what actually gets charged.
  const finalPrice = ZERO_DECIMAL_CURRENCIES.has(code) ? Math.round(rawFinal) : Math.round(rawFinal * 100) / 100;

  return { currencyCode: code, finalPrice, discountPercent };
}

// Confirms the request carries a real, currently-valid Supabase login
// session, and returns the id of whoever is logged in. Returns null if the
// token is missing/invalid/expired — callers must treat that as "not
// logged in" and refuse the request.
async function getVerifiedBusinessId(req, supabaseAdmin) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on the server." });
    return;
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- WHO: verified from the login token, never from req.body ----
  const businessId = await getVerifiedBusinessId(req, supabaseAdmin);
  if (!businessId) {
    res.status(401).json({ error: "You must be logged in to start a payment." });
    return;
  }

  // ---- HOW MUCH: looked up and computed here, never from req.body ----
  const { data: business, error: fetchError } = await supabaseAdmin
    .from("businesses")
    .select("subscription_status, discount_percent, reward_credits, currency_code")
    .eq("id", businessId)
    .single();

  if (fetchError || !business) {
    res.status(404).json({ error: "Couldn't find your account." });
    return;
  }

  const { currencyCode, finalPrice } = computePriceForBusiness(business, business.currency_code || "PHP");

  // PayMongo only ever settles in PHP — if this account is billed in a
  // different display currency, this endpoint isn't the right one for
  // them (the app should be routing them to PayPal instead). Refuse
  // rather than silently charging the wrong currency's number as pesos.
  if (currencyCode !== "PHP") {
    res.status(400).json({ error: "This account isn't billed in PHP — use the PayPal checkout instead." });
    return;
  }

  const description = "OpSteward subscription";
  const amountCentavos = Math.round(finalPrice * 100);

  // ---- FREE RENEWAL PATH: server's OWN calculation rounds to exactly ₱0 ----
  if (amountCentavos === 0) {
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
  }

  // ---- NORMAL PAID PATH ----
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: "PAYMONGO_SECRET_KEY is not set on the server." });
    return;
  }

  const origin =
    process.env.APP_URL ||
    (req.headers.origin ? req.headers.origin : `https://${req.headers.host}`);

  try {
    const resp = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${secretKey}:`).toString("base64"),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            description,
            line_items: [
              {
                currency: "PHP",
                amount: amountCentavos,
                name: description,
                quantity: 1,
              },
            ],
            payment_method_types: ["gcash", "paymaya", "card"],
            // Ties this checkout back to one business account — read by
            // api/paymongo-webhook.js. Note this is the SERVER-VERIFIED
            // businessId, not anything the browser sent.
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

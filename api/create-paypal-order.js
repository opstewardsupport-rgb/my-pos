// =============================================================================
// api/create-paypal-order.js — Vercel serverless function (SECURITY FIX)
// =============================================================================
// WHAT CHANGED AND WHY — same issue and same fix as create-paymongo-link.js:
// the old version trusted `amount`, `currency`, and `businessId` straight
// from the browser. That let anyone (a) get any account activated for
// free by sending amount: 0, or (b) pay any amount they typed for a real
// order (e.g. $0.01 instead of $35). Neither the PayPal order creation nor
// the webhook that confirms payment had any way to know the "right" price.
//
// THE FIX: this file now verifies who is logged in from their Supabase
// session token, and computes the price itself from that account's own
// discount_percent / reward_credits / currency_code in the database — the
// browser no longer gets a say in either.
//
// ACTION NEEDED FROM YOU: see the MAX_REWARD_CREDIT_PERCENT comment below
// — same note as in create-paymongo-link.js.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tdgcyffbblxxccsujtdy.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PAYPAL_API_BASE = (process.env.PAYPAL_ENV || "live") === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

// ---- Pricing table — must match LOCKED_SUBSCRIPTION_PRICE_PHP in
// cafe-pos.jsx exactly. ----
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

function formatAmount(amount, currency) {
  const n = Math.max(0, Number(amount) || 0);
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(n)) : n.toFixed(2);
}

function computePriceForBusiness(business) {
  const requestedCode = business.currency_code || "PHP";
  const code = LOCKED_SUBSCRIPTION_PRICE_PHP[requestedCode] !== undefined ? requestedCode : "PHP";
  const fullPrice = LOCKED_SUBSCRIPTION_PRICE_PHP[code];

  const hasSubscribedBefore = business.subscription_status === "active";
  const rewardCreditPercent = Math.min(Number(business.reward_credits) || 0, MAX_REWARD_CREDIT_PERCENT);
  const signupDiscountPercent = Number(business.discount_percent) || 0;
  const discountPercent = hasSubscribedBefore ? rewardCreditPercent : signupDiscountPercent;

  const rawFinal = fullPrice * (1 - discountPercent / 100);
  const finalPrice = ZERO_DECIMAL_CURRENCIES.has(code) ? Math.round(rawFinal) : Math.round(rawFinal * 100) / 100;

  return { currencyCode: code, finalPrice };
}

async function getVerifiedBusinessId(req, supabaseAdmin) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PayPal isn't set up yet — PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are missing.");
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || "Couldn't authenticate with PayPal.");
  }
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set on the server." });
    return;
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
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

    const { currencyCode, finalPrice } = computePriceForBusiness(business);

    // PayPal is only offered to non-PHP accounts (PHP uses PayMongo) —
    // refuse rather than silently creating a PayPal order for a PHP
    // account.
    if (currencyCode === "PHP") {
      res.status(400).json({ error: "This account is billed in PHP — use the PayMongo checkout instead." });
      return;
    }

    const description = "OpSteward subscription";

    // ---- FREE RENEWAL PATH: server's OWN calculation rounds to exactly 0 ----
    if (finalPrice === 0) {
      const { error } = await supabaseAdmin.rpc("activate_subscription", {
        p_business_id: businessId,
        p_reference: "free-100pct-discount",
      });
      if (error) {
        console.error("create-paypal-order: free activation failed.", businessId, error);
        throw new Error("Couldn't activate your free month — please try again.");
      }
      res.status(200).json({ activated: true });
      return;
    }

    const accessToken = await getAccessToken();
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const orderResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            // Read by api/paypal-webhook.js — this is the SERVER-VERIFIED
            // businessId, not anything the browser sent.
            custom_id: String(businessId),
            description: description.slice(0, 127),
            amount: {
              currency_code: currencyCode,
              value: formatAmount(finalPrice, currencyCode),
            },
          },
        ],
        application_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: `${origin}/paypal-return.html`,
          cancel_url: `${origin}/paypal-cancel.html`,
        },
      }),
    });

    const orderData = await orderResp.json();
    if (!orderResp.ok) {
      throw new Error(orderData?.message || "PayPal couldn't create the order.");
    }

    const approveLink = (orderData.links || []).find((l) => l.rel === "approve");
    if (!approveLink) {
      throw new Error("PayPal didn't return a checkout link.");
    }

    res.status(200).json({ url: approveLink.href, orderId: orderData.id });
  } catch (err) {
    console.error("create-paypal-order failed:", err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  }
}

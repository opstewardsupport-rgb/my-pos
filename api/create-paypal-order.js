// api/create-paypal-order.js
//
// Called by startPayPalCheckout() in cafe-pos.jsx whenever an international
// subscriber clicks "Pay now". Creates a real PayPal Order (via PayPal's
// Checkout API) for the exact amount shown on screen, with the subscriber's
// account id attached as custom_id — that's what lets api/paypal-webhook.js
// know whose account to activate once this order is paid.
//
// ONE-TIME SETUP — see the big comment above PAYPAL_CREATE_ORDER_ENDPOINT
// near the top of cafe-pos.jsx. In short, this file needs these Vercel
// environment variables set:
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_ENV        ("live" or "sandbox" — defaults to "live" if unset)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://tdgcyffbblxxccsujtdy.supabase.co";

const PAYPAL_API_BASE = (process.env.PAYPAL_ENV || "live") === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

// PayPal requires whole-cent amounts as a plain string with the right
// number of decimal places for the currency (0 for JPY-style currencies).
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "IDR", "VND"]);
function formatAmount(amount, currency) {
  const n = Math.max(0, Number(amount) || 0);
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(n)) : n.toFixed(2);
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

  try {
    const { amount, currency, description, businessId } = req.body || {};
    const amt = Number(amount);
    if (!businessId) {
      res.status(400).json({ error: "Missing businessId." });
      return;
    }
    if (!currency || !Number.isFinite(amt) || amt < 0) {
      res.status(400).json({ error: "Missing or invalid amount/currency." });
      return;
    }

    // A 100% discount brings the final price to exactly 0 — PayPal can't
    // create an order for $0, so activate the subscription directly
    // instead, the same way create-paymongo-link.js already does for a
    // ₱0 PayMongo link. Uses the SERVICE ROLE key because this runs on
    // your server, not as the logged-in subscriber.
    if (amt === 0) {
      const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase.rpc("activate_subscription", {
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

    // The URLs PayPal sends the subscriber back to after approving or
    // cancelling — these pages just need to exist so the popup has
    // somewhere to land; the webhook (not these pages) is what actually
    // activates the account. req.headers.origin is the domain this POS is
    // hosted on, whatever that is.
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
            // Lets api/paypal-webhook.js know whose account to activate.
            custom_id: String(businessId),
            description: (description || "Subscription").slice(0, 127),
            amount: {
              currency_code: currency,
              value: formatAmount(amt, currency),
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

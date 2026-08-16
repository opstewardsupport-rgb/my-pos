// api/paypal-webhook.js
//
// PayPal calls this URL directly (server-to-server, no browser involved)
// the moment a subscriber approves an order created by
// api/create-paypal-order.js. This verifies the request genuinely came
// from PayPal, captures the payment, then activates the right account by
// calling the activate_subscription() database function — see the "PAYPAL
// AUTOMATIC ACTIVATION SETUP" SQL block near the top of cafe-pos.jsx.
//
// ONE-TIME SETUP — see the big comment above PAYPAL_CREATE_ORDER_ENDPOINT
// near the top of cafe-pos.jsx. In short, this file needs these Vercel
// environment variables set:
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_ENV                 ("live" or "sandbox" — defaults to "live")
//   PAYPAL_WEBHOOK_ID          (from PayPal Dashboard → your app → Webhooks)
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase → Settings → API → service_role —
//                                NOT the anon key; keep this one secret)
// PayPal Dashboard → your app → Webhooks → Add Webhook, pointed at:
//   https://<your-app-domain>/api/paypal-webhook
// with the "Checkout order approved" event checked.

const { createClient } = require("@supabase/supabase-js");

const PAYPAL_API_BASE = (process.env.PAYPAL_ENV || "live") === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

const SUPABASE_URL = "https://tdgcyffbblxxccsujtdy.supabase.co";

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
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

// Confirms this request really came from PayPal (not someone hitting this
// URL directly to activate accounts for free) using PayPal's own
// Verify Webhook Signature API.
async function verifySignature(accessToken, headers, body) {
  const resp = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: body,
    }),
  });
  const data = await resp.json();
  return data.verification_status === "SUCCESS";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    const accessToken = await getAccessToken();
    const isVerified = await verifySignature(accessToken, req.headers, req.body);
    if (!isVerified) {
      console.error("paypal-webhook: signature verification failed.");
      res.status(400).send("Invalid signature");
      return;
    }

    const event = req.body;
    // Only act on an approved order — nothing else this app subscribes to.
    if (event.event_type !== "CHECKOUT.ORDER.APPROVED") {
      res.status(200).send("Ignored");
      return;
    }

    const order = event.resource;
    const orderId = order.id;
    const purchaseUnit = (order.purchase_units || [])[0];
    const businessId = purchaseUnit?.custom_id;
    if (!businessId) {
      console.error("paypal-webhook: approved order had no custom_id.", orderId);
      res.status(200).send("No businessId on order — ignored");
      return;
    }

    // Actually take the payment now that the subscriber has approved it.
    const captureResp = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const captureData = await captureResp.json();
    const captureStatus = captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (!captureResp.ok || captureStatus !== "COMPLETED") {
      console.error("paypal-webhook: capture failed.", orderId, captureData);
      res.status(200).send("Capture failed — no action taken");
      return;
    }

    // Payment is confirmed — activate the account. Uses the SERVICE ROLE
    // key deliberately: this runs on your server, never in a browser, and
    // needs to write to an account that isn't the one making this request.
    const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabase.rpc("activate_subscription", {
      p_business_id: businessId,
      p_reference: orderId,
    });
    if (error) {
      console.error("paypal-webhook: activate_subscription failed.", businessId, error);
      res.status(500).send("Activation failed");
      return;
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("paypal-webhook failed:", err);
    res.status(500).send("Internal error");
  }
};

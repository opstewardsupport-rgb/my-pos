// =============================================================================
// api/create-paymongo-link.js — Vercel serverless function
// =============================================================================
// Called by the app (startPayMongoCheckout() in cafe-pos.jsx) the moment a
// PH subscriber clicks "Pay now". Creates a brand-new PayMongo Checkout
// Session priced at the EXACT peso amount shown on screen, tags it with
// businessId (so the webhook — api/paymongo-webhook.js — knows whose
// account to reactivate once it's paid), and hands back the checkout URL.
//
// ONE-TIME SETUP (Vercel → your project → Settings → Environment Variables):
//   PAYMONGO_SECRET_KEY = your PayMongo secret key (sk_test_... while
//   testing, sk_live_... for real charges). PayMongo Dashboard →
//   Developers → API Keys.
//
// This file must never run in the browser — it's the one place your secret
// key is allowed to exist, because only Vercel's servers can read
// process.env here.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: "PAYMONGO_SECRET_KEY is not set on the server." });
    return;
  }

  const { amountPhp, description, businessId } = req.body || {};

  const amount = Number(amountPhp);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amountPhp must be a positive number." });
    return;
  }
  if (!businessId) {
    res.status(400).json({ error: "businessId is required." });
    return;
  }

  // PayMongo amounts are always in centavos (smallest unit) — ₱1,699.00
  // becomes 169900. Rounded because reward-credit math can produce
  // fractional pesos.
  const amountCentavos = Math.round(amount * 100);

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

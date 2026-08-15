// api/create-paymongo-link.js
//
// Vercel serverless function — this is the "backend" half of automatic
// PayMongo checkout for cafe-pos.jsx (see PAYMONGO_CREATE_LINK_ENDPOINT and
// startPayMongoCheckout() in that file for the frontend half). It creates a
// brand-new PayMongo Payment Link priced at whatever exact amount the app
// asks for — full price, a first-payment 25% referral discount, or any
// accumulated reward-credit % on a renewal — and hands back that link's
// checkout URL. That's what makes PayMongo "automatic": there's no
// fixed-price link to create ahead of time or keep in sync with an
// ever-changing discount.
//
// WHY THIS HAS TO BE A SEPARATE SERVER FILE, NOT PART OF cafe-pos.jsx:
// Creating a PayMongo Payment Link at an arbitrary amount requires your
// PayMongo SECRET key (PayMongo's own API docs: Payment Links/Intents are
// a server-side-only operation). A secret key must never be shipped to the
// browser — cafe-pos.jsx is plain client-side React that anyone can
// inspect via dev tools, so any key living there is effectively public. A
// Vercel serverless function, by contrast, only ever runs on Vercel's
// servers; the browser calls it over the network and never sees its code
// or its environment variables. That boundary is the entire reason this
// file exists.
//
// ---- ONE-TIME SETUP (you only do this once, in dashboards — not code) ----
// 1. In your PayMongo Dashboard: Developers → API Keys → copy your SECRET
//    key. Use the sk_test_… key while you're testing, switch to your
//    sk_live_… key when you're ready to accept real payments.
// 2. In your Vercel project: Settings → Environment Variables → add a new
//    variable named exactly
//        PAYMONGO_SECRET_KEY
//    with that secret key as its value → Save.
// 3. Redeploy your project (Deployments tab → ⋯ on the latest deployment →
//    Redeploy) so this function can actually see the new variable — Vercel
//    only injects environment variables into deployments made AFTER
//    they're added.
// That's it — nothing in cafe-pos.jsx or anywhere else in the repo needs
// your PayMongo key; this is the only file that ever touches it.
//
// ---- HOW TO ADD THIS FILE VIA THE GITHUB WEB INTERFACE ----
// In your repo: Add file → Create new file → for the file name, type
//   api/create-paymongo-link.js
// (typing the "api/" part creates that folder for you) → paste this whole
// file as the contents → Commit directly to your main branch. Vercel
// automatically treats any .js file under /api at your repo root as a
// serverless function — no other config needed for this to start working
// once PAYMONGO_SECRET_KEY is set (step 2 above) and the app redeploys.
//
// ---- WHAT IT DOES, STEP BY STEP ----
// The frontend POSTs { amountPhp, description } (amountPhp is a plain peso
// number like 1274.25 — see phpFinalPrice in UpgradeView). This function:
//   1. Converts that to centavos (PayMongo's smallest-unit convention —
//      PHP 100.00 is sent as 10000) and rounds it, since PayMongo won't
//      accept fractional centavos.
//   2. Calls PayMongo's Links API (POST /v1/links) with your secret key to
//      create a single-use Payment Link at that exact amount.
//   3. Returns { url: <checkout_url> } to the frontend, which opens it in
//      the in-app checkout frame.
// If anything goes wrong (missing/invalid key, PayMongo's API is down,
// amount too small, etc.) it returns a JSON { error } message instead —
// the frontend falls back to the manual GCash/bank-transfer note when that
// happens, so a subscriber is never just stuck on a blank screen.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    // This is almost always step 2/3 of the setup above not having been
    // done yet (or done, but not redeployed). Deliberately vague to the
    // client — the real detail goes to the server logs, not the browser.
    console.error("create-paymongo-link: PAYMONGO_SECRET_KEY is not set.");
    res.status(500).json({ error: "Payments aren't configured yet. Please try again later or contact support." });
    return;
  }

  let body = req.body;
  // Some Vercel runtimes hand you the raw body as a string instead of a
  // parsed object depending on Content-Type — handle both so this doesn't
  // silently 500 on a technicality.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const { amountPhp, description } = body || {};

  const amountCentavos = Math.round(Number(amountPhp) * 100);

  // PayMongo's documented minimum charge is ₱20.00 (2000 centavos).
  // Rejecting anything below that here gives a clearer error than letting
  // PayMongo's own API reject it.
  if (!Number.isFinite(amountCentavos) || amountCentavos < 2000) {
    res.status(400).json({ error: "Invalid payment amount." });
    return;
  }

  try {
    const paymongoRes = await fetch("https://api.paymongo.com/v1/links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${secretKey}:`).toString("base64"),
      },
      body: JSON.stringify({
        data: {
          attributes: {
            amount: amountCentavos,
            currency: "PHP",
            description: String(description || "OpSteward QuickServe POS subscription").slice(0, 255),
          },
        },
      }),
    });

    const data = await paymongoRes.json().catch(() => null);

    if (!paymongoRes.ok) {
      const message = data?.errors?.[0]?.detail || "PayMongo couldn't create a payment link.";
      console.error("create-paymongo-link: PayMongo API error:", paymongoRes.status, message);
      res.status(502).json({ error: message });
      return;
    }

    const checkoutUrl = data?.data?.attributes?.checkout_url;
    if (!checkoutUrl) {
      console.error("create-paymongo-link: no checkout_url in PayMongo response:", JSON.stringify(data));
      res.status(502).json({ error: "PayMongo didn't return a checkout link." });
      return;
    }

    res.status(200).json({ url: checkoutUrl });
  } catch (err) {
    console.error("create-paymongo-link: request to PayMongo failed:", err);
    res.status(500).json({ error: "Couldn't reach PayMongo just now." });
  }
};

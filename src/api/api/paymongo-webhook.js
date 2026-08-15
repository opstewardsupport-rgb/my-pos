// =============================================================================
// api/paymongo-webhook.js — Vercel serverless function
// =============================================================================
// This is the piece that makes activation AUTOMATIC. PayMongo calls this
// URL itself, the instant a checkout session gets paid — no need for the
// subscriber (or you) to do anything else. It:
//   1. Confirms the request genuinely came from PayMongo (signature check).
//   2. Reads the business_id that create-paymongo-link.js tagged the
//      checkout with.
//   3. Calls activate_subscription_for_business() in Supabase (see
//      supabase-activate-subscription.sql) to flip that account back to
//      "active" — same as clicking a "Payment confirmed" button, just
//      done by PayMongo instead of a person.
//
// ONE-TIME SETUP:
//   A) Vercel → your project → Settings → Environment Variables, add:
//      - SUPABASE_URL = https://tdgcyffbblxxccsujtdy.supabase.co
//      - SUPABASE_SERVICE_ROLE_KEY = your SERVICE ROLE key (Supabase
//        dashboard → Settings → API → "service_role" — NOT the anon key
//        already in cafe-pos.jsx; this one bypasses all the safety rules,
//        so it must never appear in the browser code, only here).
//      - PAYMONGO_WEBHOOK_SECRET = filled in during step B below.
//      Redeploy after adding these (Deployments → ⋯ → Redeploy).
//
//   B) PayMongo Dashboard → Developer Tools → Webhooks → Add Endpoint:
//      - URL: https://<your-deployed-domain>/api/paymongo-webhook
//      - Events: check "checkout_session.payment.paid"
//      - Save. PayMongo will show you an endpoint secret (starts with
//        whsk_) — copy it into PAYMONGO_WEBHOOK_SECRET above and redeploy.

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// Vercel-specific: turns off automatic body parsing so we can read the
// EXACT raw bytes PayMongo sent. Signature verification only works against
// the untouched raw body — even reformatting the JSON breaks it.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// PayMongo's Paymongo-Signature header looks like:
//   t=1700000000,te=<hmac for test-mode events>,li=<hmac for live-mode events>
// You compute HMAC-SHA256 of "<timestamp>.<raw body>" using your webhook's
// secret key, then compare it to whichever of te/li matches your mode.
// We just check against BOTH — it costs nothing extra and works whether
// you're testing (sk_test_) or live (sk_live_).
function isValidSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const { t, te, li } = parts;
  if (!t || (!te && !li)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");

  const matches = (candidate) =>
    !!candidate &&
    candidate.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));

  return matches(te) || matches(li);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end("Method not allowed");
    return;
  }

  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !supabaseUrl || !serviceRoleKey) {
    console.error("paymongo-webhook: missing required environment variables.");
    res.status(500).end("Server not configured.");
    return;
  }

  const rawBody = await readRawBody(req);

  // Reject anything that isn't provably from PayMongo BEFORE looking at
  // its contents at all — this is what stops anyone else on the internet
  // from POSTing a fake "payment succeeded" straight to this URL and
  // getting a free subscription.
  const signatureHeader = req.headers["paymongo-signature"];
  if (!isValidSignature(rawBody, signatureHeader, webhookSecret)) {
    console.warn("paymongo-webhook: signature verification failed.");
    res.status(400).end("Invalid signature.");
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    res.status(400).end("Invalid JSON.");
    return;
  }

  const eventType = event?.data?.attributes?.type;
  // Only reacting to a paid Checkout Session — anything else (a failed
  // payment, a refund, etc.) is acknowledged but ignored.
  if (eventType !== "checkout_session.payment.paid") {
    res.status(200).end("Ignored (not a paid checkout).");
    return;
  }

  const checkoutSession = event?.data?.attributes?.data;
  const businessId = checkoutSession?.attributes?.metadata?.business_id;
  const paymentId =
    checkoutSession?.attributes?.payments?.[0]?.id || checkoutSession?.id || null;

  if (!businessId) {
    console.error("paymongo-webhook: paid event had no business_id in metadata.", event?.data?.id);
    // Acknowledge with 200 anyway — this is a data problem on our end
    // (or an old checkout created before metadata was added), not
    // something PayMongo should keep retrying forever.
    res.status(200).end("No business_id on this event.");
    return;
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
  const { error } = await supabaseAdmin.rpc("activate_subscription_for_business", {
    p_business_id: businessId,
    p_reference: paymentId,
  });

  if (error) {
    console.error("paymongo-webhook: activate_subscription_for_business failed:", error);
    // 500 here tells PayMongo to retry this event later instead of
    // silently losing a real payment because of a transient DB hiccup.
    res.status(500).end("Failed to activate subscription.");
    return;
  }

  res.status(200).end("OK");
}

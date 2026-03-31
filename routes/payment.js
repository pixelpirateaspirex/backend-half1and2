'use strict';

/**
 * routes/payment.js
 *
 * Mount in server.js BEFORE express.json() middleware, or structure it like:
 *
 *   // Raw body for Stripe webhook — must come BEFORE express.json()
 *   app.post(
 *     '/api/payment/webhook',
 *     express.raw({ type: 'application/json' }),
 *     require('./controllers/paymentController').handleWebhook
 *   );
 *
 *   // Then mount the rest of the payment routes normally
 *   app.use('/api/payment', require('./routes/payment'));
 *
 * If you prefer to keep everything here, the router handles it by registering
 * the webhook FIRST (before any JSON body-parser can touch it).
 */

const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');const pc      = require('../controllers/paymentController');

// ─── Webhook (RAW body — no auth middleware, called by Stripe) ───────────────
// express.raw() on this specific route ensures Stripe signature verification works.
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  pc.handleWebhook
);

// ─── Protected payment routes ─────────────────────────────────────────────────

// Create a Stripe Checkout Session → returns { url }
router.post('/create-checkout-session', auth, pc.createCheckoutSession);

// Get subscription status for the logged-in user
router.get('/status', auth, pc.getSubscriptionStatus);

// Verify a Stripe session after redirect (used on /payment-success page)
router.get('/verify-session', auth, pc.verifySession);

// Cancel subscription at period end
router.post('/cancel', auth, pc.cancelSubscription);

module.exports = router;

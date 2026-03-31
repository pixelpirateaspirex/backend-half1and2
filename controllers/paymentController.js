'use strict';

/**
 * controllers/paymentController.js
 *
 * Stripe integration:
 *   1. createCheckoutSession  — creates a Stripe Checkout Session and returns the URL
 *   2. handleWebhook          — verifies Stripe signature, handles checkout.session.completed
 *   3. getSubscriptionStatus  — returns the current user's subscription state
 *   4. cancelSubscription     — marks the subscription as cancelled (no Stripe refund logic here)
 *
 * Environment variables required (.env):
 *   STRIPE_SECRET_KEY         — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET     — whsec_… (from Stripe Dashboard → Webhooks)
 *   STRIPE_PRICE_ID           — price_… (the recurring price ID for your ₹199/mo product)
 *   CLIENT_URL                — https://yourdomain.com  (no trailing slash)
 *
 * Stripe npm:  npm install stripe
 */

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User     = require('../models/User');
const UserData = require('../models/UserData');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Attach / retrieve a Stripe Customer ID for the current user.
 * We store it on the User document so we never create duplicates.
 */
async function getOrCreateStripeCustomer(user) {
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email:    user.email,
    name:     user.name || user.email,
    metadata: { userId: user._id.toString() },
  });

  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

// ─── 1. Create Checkout Session ──────────────────────────────────────────────

/**
 * POST /api/payment/create-checkout-session
 *
 * Protected route (requires auth middleware).
 * Returns: { url } — redirect the browser (or the frontend) to this URL.
 *
 * Optionally accepts:
 *   Body: { priceId }  — override the default price (for future plan tiers)
 */
exports.createCheckoutSession = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Block if already subscribed and active
    if (
      user.subscription?.status === 'active' &&
      user.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date()
    ) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active Premium subscription.',
        subscription: user.subscription,
      });
    }

    const customerId = await getOrCreateStripeCustomer(user);
    const priceId    = req.body?.priceId || process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      return res
        .status(500)
        .json({ success: false, message: 'STRIPE_PRICE_ID is not configured.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode:                'subscription',
      payment_method_types: ['card'],
      customer:            customerId,
      line_items: [
        {
          price:    priceId,
          quantity: 1,
        },
      ],
      // Include user ID so the webhook can find the right account
      metadata: {
        userId:    user._id.toString(),
        userEmail: user.email,
      },
      // Persist metadata on the subscription object too
      subscription_data: {
        metadata: {
          userId:    user._id.toString(),
          userEmail: user.email,
        },
      },
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.CLIENT_URL}/payment-cancel`,
      // Pre-fill email to reduce friction
      customer_email: user.stripeCustomerId ? undefined : user.email,
    });

    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[createCheckoutSession]', err);
    res.status(500).json({ success: false, message: err.message || 'Payment session error.' });
  }
};

// ─── 2. Stripe Webhook ───────────────────────────────────────────────────────

/**
 * POST /api/payment/webhook
 *
 * IMPORTANT: This route must receive the RAW body (Buffer), NOT the JSON-parsed body.
 * In server.js, mount this route BEFORE express.json() or use:
 *
 *   app.post(
 *     '/api/payment/webhook',
 *     express.raw({ type: 'application/json' }),
 *     require('./controllers/paymentController').handleWebhook
 *   );
 *
 * This is an unprotected route (called by Stripe servers, not your users).
 */
exports.handleWebhook = async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set!');
    return res.status(500).send('Webhook secret not configured.');
  }

  let event;
  try {
    // req.body must be the raw Buffer — see note above
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle events ──────────────────────────────────────────────────────────
  try {
    switch (event.type) {

      // Payment succeeded → activate subscription
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status === 'paid') {
          await activateSubscription(session);
        }
        break;
      }

      // Recurring renewal
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId       = subscription.metadata?.userId;
          if (userId) {
            await renewSubscription(userId, subscription);
          }
        }
        break;
      }

      // Payment failed — mark subscription as past_due
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId       = subscription.metadata?.userId;
          if (userId) {
            await User.findByIdAndUpdate(userId, {
              'subscription.status': 'past_due',
              'subscription.updatedAt': new Date(),
            });
          }
        }
        break;
      }

      // Customer cancelled
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId       = subscription.metadata?.userId;
        if (userId) {
          await User.findByIdAndUpdate(userId, {
            'subscription.status':    'cancelled',
            'subscription.updatedAt': new Date(),
          });
          // Revoke quiz unlock when subscription lapses
          await UserData.findOneAndUpdate(
            { user: userId },
            { quizUnlocked: false }
          );
        }
        break;
      }

      // Subscription updated (plan change, trial end, etc.)
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId       = subscription.metadata?.userId;
        if (userId && subscription.status === 'active') {
          const expiresAt = new Date(subscription.current_period_end * 1000);
          await User.findByIdAndUpdate(userId, {
            'subscription.status':           'active',
            'subscription.expiresAt':        expiresAt,
            'subscription.stripeSubId':      subscription.id,
            'subscription.stripePriceId':    subscription.items.data[0]?.price?.id || '',
            'subscription.updatedAt':        new Date(),
          });
        }
        break;
      }

      default:
        // Log unknown events in development
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[webhook] Unhandled event type: ${event.type}`);
        }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Handler error:', err);
    // Always return 200 to Stripe so it doesn't retry — log internally
    res.json({ received: true, error: 'Internal handler error logged.' });
  }
};

/** Activate subscription after successful checkout */
async function activateSubscription(session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error('[activateSubscription] No userId in session metadata:', session.id);
    return;
  }

  // Retrieve the subscription Stripe created
  const stripeSubId = session.subscription;
  let expiresAt     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback: +30 days

  if (stripeSubId) {
    try {
      const sub = await stripe.subscriptions.retrieve(stripeSubId);
      expiresAt = new Date(sub.current_period_end * 1000);
    } catch (_) {}
  }

  await User.findByIdAndUpdate(userId, {
    'subscription.status':           'active',
    'subscription.plan':             'premium',
    'subscription.stripeSubId':      stripeSubId || '',
    'subscription.stripeSessionId':  session.id,
    'subscription.stripePriceId':    session.metadata?.priceId || process.env.STRIPE_PRICE_ID || '',
    'subscription.activatedAt':      new Date(),
    'subscription.expiresAt':        expiresAt,
    'subscription.updatedAt':        new Date(),
    'subscription.orderId':          'PP-' + session.id.slice(-10).toUpperCase(),
  });

  // Unlock quiz for the subscriber
  await UserData.findOneAndUpdate(
    { user: userId },
    { quizUnlocked: true },
    { upsert: true }
  );

  console.log(`[activateSubscription] Premium activated for user ${userId}`);
}

/** Extend subscription expiry on recurring renewal */
async function renewSubscription(userId, subscription) {
  const expiresAt = new Date(subscription.current_period_end * 1000);
  await User.findByIdAndUpdate(userId, {
    'subscription.status':    'active',
    'subscription.expiresAt': expiresAt,
    'subscription.updatedAt': new Date(),
  });
  await UserData.findOneAndUpdate(
    { user: userId },
    { quizUnlocked: true },
    { upsert: true }
  );
  console.log(`[renewSubscription] Subscription renewed for user ${userId} until ${expiresAt}`);
}

// ─── 3. Get Subscription Status ───────────────────────────────────────────────

/**
 * GET /api/payment/status
 * Protected. Returns the authenticated user's subscription info.
 */
exports.getSubscriptionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('subscription name email');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const sub       = user.subscription || {};
    const now       = new Date();
    const isActive  =
      sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > now;

    res.json({
      success: true,
      data: {
        isActive,
        plan:       sub.plan || 'free',
        status:     sub.status || 'inactive',
        expiresAt:  sub.expiresAt || null,
        activatedAt: sub.activatedAt || null,
        orderId:    sub.orderId || null,
      },
    });
  } catch (err) {
    console.error('[getSubscriptionStatus]', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ─── 4. Cancel Subscription ───────────────────────────────────────────────────

/**
 * POST /api/payment/cancel
 * Protected. Cancels the Stripe subscription at period end (no immediate refund).
 */
exports.cancelSubscription = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.subscription?.stripeSubId) {
      return res.status(400).json({
        success: false,
        message: 'No active Stripe subscription found.',
      });
    }

    // Cancel at period end — user keeps access until expiry date
    await stripe.subscriptions.update(user.subscription.stripeSubId, {
      cancel_at_period_end: true,
    });

    user.subscription.status    = 'cancelling';
    user.subscription.updatedAt = new Date();
    await user.save();

    res.json({
      success: true,
      message: 'Your subscription will be cancelled at the end of the current billing period.',
      expiresAt: user.subscription.expiresAt,
    });
  } catch (err) {
    console.error('[cancelSubscription]', err);
    res.status(500).json({ success: false, message: err.message || 'Cancellation failed.' });
  }
};

// ─── 5. Verify Session (post-redirect check) ─────────────────────────────────

/**
 * GET /api/payment/verify-session?session_id=cs_xxx
 * Called by the frontend after Stripe redirects to /payment-success.
 * Returns payment status without re-processing (webhook already did that).
 */
exports.verifySession = async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ success: false, message: 'session_id is required.' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Verify the session belongs to the authenticated user
    const userId = session.metadata?.userId;
    if (!userId || userId !== req.user.id.toString()) {
      return res.status(403).json({ success: false, message: 'Session does not belong to this user.' });
    }

    const user = await User.findById(req.user.id).select('subscription');

    res.json({
      success:        true,
      paymentStatus:  session.payment_status,   // 'paid' | 'unpaid' | 'no_payment_required'
      sessionStatus:  session.status,            // 'complete' | 'expired' | 'open'
      subscription:   user?.subscription || {},
    });
  } catch (err) {
    console.error('[verifySession]', err);
    res.status(500).json({ success: false, message: err.message || 'Session verification failed.' });
  }
};

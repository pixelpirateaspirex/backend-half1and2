'use strict';

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
//  USER SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const UserSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, 'Name is required'],
      trim:      true,
      minlength: [2,  'Name must be at least 2 characters'],
      maxlength: [60, 'Name cannot exceed 60 characters'],
    },
    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,
      lowercase: true,
      trim:      true,
      match:     [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    password: {
      type:      String,
      minlength: [6, 'Password must be at least 6 characters'],
      select:    false,
    },
    photoURL: {
      type:    String,
      default: '',
    },

    // ── Auth provider ────────────────────────────────────────────────────────
    provider: {
      type:    String,
      enum:    ['local', 'google'],
      default: 'local',
    },
    googleId: {
      type:    String,
      sparse:  true,
      default: null,
    },
    firebaseUid: { type: String, sparse: true, index: true },

    // ── Premium / Subscription (legacy flat fields — kept for compatibility) ──
    isPremium: {
      type:    Boolean,
      default: false,
    },
    premiumType: {
      type:    String,
      enum:    ['none', 'monthly', 'free_earned'],
      default: 'none',
    },
    premiumActivatedAt: { type: Date, default: null },
    premiumExpiresAt:   { type: Date, default: null },

    // ── Stripe identifiers (top-level, kept for compatibility) ────────────────
    stripeCustomerId:    { type: String, default: null },
    stripeSubscriptionId:{ type: String, default: null },

    // ── FIX: Subscription subdocument — required by paymentController.js ─────
    // paymentController reads/writes user.subscription.status, .plan, .stripeSubId
    // etc. This subdocument keeps all Stripe state in one place.
    subscription: {
      status: {
        type:    String,
        enum:    ['inactive', 'active', 'past_due', 'cancelled', 'cancelling'],
        default: 'inactive',
      },
      plan:           { type: String, default: 'free' },
      stripeSubId:    { type: String, default: null },   // Stripe subscription ID
      stripeSessionId:{ type: String, default: null },   // Stripe checkout session ID
      stripePriceId:  { type: String, default: null },   // Stripe price ID
      activatedAt:    { type: Date,   default: null },
      expiresAt:      { type: Date,   default: null },
      updatedAt:      { type: Date,   default: null },
      orderId:        { type: String, default: null },   // e.g. "PP-XXXXXXXXXX"
    },

    // ── Quiz state ────────────────────────────────────────────────────────────
    quizPoints:       { type: Number,  default: 0 },
    quizAttempted:    { type: Boolean, default: false },
    quizUnlocked:     { type: Boolean, default: false },
    firstQuizAttempt: { type: Boolean, default: true },

    // ── Password reset ────────────────────────────────────────────────────────
    passwordResetToken:   { type: String, select: false },
    passwordResetExpires: { type: Date,   select: false },

    // ── Email verification ────────────────────────────────────────────────────
    isEmailVerified:        { type: Boolean, default: false },
    emailVerificationToken: { type: String,  select: false },

    // ── Account lifecycle ─────────────────────────────────────────────────────
    isActive:  { type: Boolean, default: true },
    lastLogin: { type: Date,    default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        delete ret.emailVerificationToken;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  INDEXES
// ════════════════════════════════════════════════════════════════════════════
UserSchema.index({ email: 1 });
UserSchema.index({ googleId: 1 }, { sparse: true });

// ════════════════════════════════════════════════════════════════════════════
//  PRE-SAVE HOOK
// ════════════════════════════════════════════════════════════════════════════
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  try {
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  INSTANCE METHODS
// ════════════════════════════════════════════════════════════════════════════
UserSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.createPasswordResetToken = function () {
  const plainToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(plainToken)
    .digest('hex');
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000;
  return plainToken;
};

/**
 * activatePremium — updates BOTH the legacy flat fields AND the new
 * subscription subdocument so both stay in sync.
 */
UserSchema.methods.activatePremium = function (type = 'monthly') {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Legacy fields (kept for any existing code that reads them)
  this.isPremium          = true;
  this.premiumType        = type;
  this.premiumActivatedAt = new Date();
  this.premiumExpiresAt   = expiresAt;
  this.quizUnlocked       = true;

  // New subscription subdocument
  this.subscription.status      = 'active';
  this.subscription.plan        = 'premium';
  this.subscription.activatedAt = new Date();
  this.subscription.expiresAt   = expiresAt;
  this.subscription.updatedAt   = new Date();
};

/**
 * deactivatePremium — updates both legacy fields and subscription subdocument.
 */
UserSchema.methods.deactivatePremium = function () {
  // Legacy fields
  this.isPremium    = false;
  this.premiumType  = 'none';
  this.quizUnlocked = false;

  // Subscription subdocument
  this.subscription.status    = 'cancelled';
  this.subscription.updatedAt = new Date();
};

// ════════════════════════════════════════════════════════════════════════════
//  VIRTUALS
// ════════════════════════════════════════════════════════════════════════════

/**
 * isPremiumActive — true if subscription is active AND not expired.
 * Checks the subscription subdocument first, falls back to legacy fields.
 */
UserSchema.virtual('isPremiumActive').get(function () {
  const now = new Date();

  // Check new subscription subdocument first
  if (this.subscription?.status === 'active' && this.subscription?.expiresAt) {
    return now < new Date(this.subscription.expiresAt);
  }

  // Fallback to legacy fields
  if (!this.isPremium) return false;
  if (!this.premiumExpiresAt) return true;
  return now < this.premiumExpiresAt;
});

// ════════════════════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════════════════════
module.exports = mongoose.model('User', UserSchema);

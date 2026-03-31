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
      select:    false, // never returned in queries unless explicitly requested
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
      sparse:  true, // allows multiple null values in the unique index
      default: null,
    },
firebaseUid: { type: String, sparse: true, index: true },
    // ── Premium / Subscription ────────────────────────────────────────────────
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

    // ── Stripe identifiers ────────────────────────────────────────────────────
stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },

    // ── Quiz state (persisted on User for fast auth-response reads) ───────────
    quizPoints:       { type: Number,  default: 0 },
    quizAttempted:    { type: Boolean, default: false },
    quizUnlocked:     { type: Boolean, default: false },
    firstQuizAttempt: { type: Boolean, default: true },

    // ── Password reset ────────────────────────────────────────────────────────
    passwordResetToken: {
      type:   String,
      select: false, // never exposed in API responses
    },
    passwordResetExpires: {
      type:   Date,
      select: false,
    },

    // ── Email verification (ready for future use) ─────────────────────────────
    isEmailVerified:        { type: Boolean, default: false },
    emailVerificationToken: { type: String,  select: false },

    // ── Account lifecycle ─────────────────────────────────────────────────────
    isActive:  { type: Boolean, default: true },
    lastLogin: { type: Date,    default: null },
  },
  {
    timestamps: true, // adds createdAt + updatedAt automatically

    // Strip sensitive fields when converting to JSON (e.g. res.json(user))
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
UserSchema.index({ googleId: 1 },          { sparse: true });

// ════════════════════════════════════════════════════════════════════════════
//  PRE-SAVE HOOK — Hash password before saving
// ════════════════════════════════════════════════════════════════════════════
UserSchema.pre('save', async function (next) {
  // Only hash if password field was actually changed
  if (!this.isModified('password') || !this.password) return next();

  try {
    // Cost factor 12 — good balance of security vs speed (~250ms on modern hardware)
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  INSTANCE METHODS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compare a plain-text candidate with the stored hash.
 * Returns true if they match, false otherwise.
 */
UserSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

/**
 * Generate a plain reset token, store its SHA-256 hash in the DB,
 * and return the plain token (to be sent via email).
 * Token expires in 10 minutes.
 */
UserSchema.methods.createPasswordResetToken = function () {
  // 32 random bytes → 64-char hex string
  const plainToken = crypto.randomBytes(32).toString('hex');

  // Hash before storing (so a DB leak can't be used to reset passwords)
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(plainToken)
    .digest('hex');

  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes

  return plainToken; // caller embeds this in the email link
};

/**
 * Activate premium subscription.
 * type: 'monthly' | 'free_earned'
 * Both grant 30 days of premium access.
 */
UserSchema.methods.activatePremium = function (type = 'monthly') {
  this.isPremium          = true;
  this.premiumType        = type;
  this.premiumActivatedAt = new Date();
  this.premiumExpiresAt   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  this.quizUnlocked       = true;
};

/**
 * Deactivate premium (called from Stripe webhook on subscription cancellation).
 */
UserSchema.methods.deactivatePremium = function () {
  this.isPremium     = false;
  this.premiumType   = 'none';
  this.quizUnlocked  = false;
  // Keep premiumExpiresAt as a record
};

// ════════════════════════════════════════════════════════════════════════════
//  VIRTUALS
// ════════════════════════════════════════════════════════════════════════════

/**
 * isPremiumActive — true if premium is set AND not yet expired.
 */
UserSchema.virtual('isPremiumActive').get(function () {
  if (!this.isPremium) return false;
  if (!this.premiumExpiresAt) return true; // no expiry = lifetime
  return new Date() < this.premiumExpiresAt;
});

// ════════════════════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════════════════════
module.exports = mongoose.model('User', UserSchema);

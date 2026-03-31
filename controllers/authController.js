'use strict';

const crypto   = require('crypto');
const User     = require('../models/User');
const UserData = require('../models/UserData');
const { signToken, signRefreshToken } = require('../middleware/auth');
const emailUtil = require('../utils/email');

// At the top with other requires:
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  HELPER — build the standard auth success response
// ════════════════════════════════════════════════════════════════════════════
function sendAuthResponse(user, statusCode, res) {
  const token        = signToken(user._id);
  const refreshToken = signRefreshToken(user._id);

  // Sanitised user payload for the frontend
  const userPayload = {
    id:               user._id,
    name:             user.name,
    email:            user.email,
    photoURL:         user.photoURL,
    provider:         user.provider,
    isPremium:        user.isPremium,
    premiumType:      user.premiumType,
    premiumExpiresAt: user.premiumExpiresAt,
    quizPoints:       user.quizPoints,
    quizAttempted:    user.quizAttempted,
    quizUnlocked:     user.quizUnlocked,
    firstQuizAttempt: user.firstQuizAttempt,
    createdAt:        user.createdAt,
  };

  res.status(statusCode).json({
    success: true,
    token,
    refreshToken,
    user: userPayload,
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/register
//  Body: { name, email, password }
// ════════════════════════════════════════════════════════════════════════════
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are all required.',
      });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Name must be at least 2 characters.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    // ── Check for existing account ────────────────────────────────────────
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists. Please sign in.',
      });
    }

    // ── Create user (password hashed by pre-save hook in User.js) ─────────
    const user = await User.create({
      name:     name.trim(),
      email:    email.toLowerCase().trim(),
      password,
      provider: 'local',
    });

    // ── Create companion UserData doc ─────────────────────────────────────
    await UserData.create({ userId: user._id });

    // ── Send welcome email (non-blocking — don't fail registration if email fails) ──
    emailUtil.sendWelcomeEmail(user.email, user.name).catch((err) => {
      console.error('Welcome email failed (non-fatal):', err.message);
    });

    sendAuthResponse(user, 201, res);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/login
//  Body: { email, password }
// ════════════════════════════════════════════════════════════════════════════
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    // Fetch user WITH password (select: false by default in schema)
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

    if (!user) {
      // Generic message — don't reveal whether email exists
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // ── Guard: Google-only account ─────────────────────────────────────────
    if (user.provider === 'google' && !user.password) {
      return res.status(400).json({
        success: false,
        message: 'This account was created with Google. Please use "Continue with Google".',
      });
    }

    // ── Verify password ───────────────────────────────────────────────────
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    // ── Update lastLogin ──────────────────────────────────────────────────
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // ── Ensure UserData exists (safety net) ───────────────────────────────
    await UserData.findOrCreate(user._id);

    sendAuthResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/google
//  Body: { idToken }  ← Google ID token from frontend (@react-oauth/google)
// ════════════════════════════════════════════════════════════════════════════
exports.googleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'Google ID token is required.' });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({
        success: false,
        message: 'Google OAuth is not configured on this server.',
      });
    }

    // ── Verify token with Google ──────────────────────────────────────────
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired Google token. Please try signing in again.',
      });
    }

    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Could not retrieve email from Google account.',
      });
    }

    // ── Find existing user by googleId OR email ───────────────────────────
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    let isNewUser = false;

    if (user) {
      // Merge Google data into existing account
      if (!user.googleId) {
        user.googleId = googleId;
        user.provider = 'google';
      }
      if (picture && !user.photoURL) user.photoURL = picture;
      if (!user.isEmailVerified) user.isEmailVerified = true;
      user.lastLogin = new Date();
      await user.save({ validateBeforeSave: false });
    } else {
      // Register brand-new user
      isNewUser = true;
      user = await User.create({
        name:            name || email.split('@')[0],
        email:           email.toLowerCase(),
        googleId,
        photoURL:        picture || '',
        provider:        'google',
        isEmailVerified: true,
      });
      await UserData.create({ userId: user._id });
    }

    // ── Ensure UserData exists ────────────────────────────────────────────
    await UserData.findOrCreate(user._id);

    // ── Welcome email for new users ───────────────────────────────────────
    if (isNewUser) {
      emailUtil.sendWelcomeEmail(user.email, user.name).catch((err) => {
        console.error('Google welcome email failed:', err.message);
      });
    }

    sendAuthResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};


// Paste this handler anywhere in the file (e.g. after exports.googleAuth):

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/firebase
//  Body: { idToken }  ← Firebase ID token from frontend
// ════════════════════════════════════════════════════════════════════════════
exports.firebaseAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, message: 'Firebase ID token is required.' });
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired Firebase token.' });
    }

    const { uid, email, name, picture, firebase: fb } = decoded;
    const provider = fb?.sign_in_provider === 'google.com' ? 'google' : 'local';

    if (!email) {
      return res.status(400).json({ success: false, message: 'Could not retrieve email from token.' });
    }

    let user = await User.findOne({ $or: [{ firebaseUid: uid }, { email: email.toLowerCase() }] });
    let isNewUser = false;

    if (user) {
      if (!user.firebaseUid) user.firebaseUid = uid;
      if (picture && !user.photoURL) user.photoURL = picture;
      user.lastLogin = new Date();
      await user.save({ validateBeforeSave: false });
    } else {
      isNewUser = true;
      user = await User.create({
        name:            name || email.split('@')[0],
        email:           email.toLowerCase(),
        firebaseUid:     uid,
        photoURL:        picture || '',
        provider,
        isEmailVerified: decoded.email_verified || false,
      });
      await UserData.create({ userId: user._id });
    }

    await UserData.findOrCreate(user._id);

    if (isNewUser) {
      emailUtil.sendWelcomeEmail(user.email, user.name).catch((e) => {
        console.error('Firebase welcome email failed (non-fatal):', e.message);
      });
    }

    sendAuthResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/auth/me  (protected)
// ════════════════════════════════════════════════════════════════════════════
exports.getMe = async (req, res) => {
  res.json({
    success: true,
    user: {
      id:               req.user._id,
      name:             req.user.name,
      email:            req.user.email,
      photoURL:         req.user.photoURL,
      provider:         req.user.provider,
      isPremium:        req.user.isPremium,
      premiumType:      req.user.premiumType,
      premiumExpiresAt: req.user.premiumExpiresAt,
      quizPoints:       req.user.quizPoints,
      quizAttempted:    req.user.quizAttempted,
      quizUnlocked:     req.user.quizUnlocked,
      firstQuizAttempt: req.user.firstQuizAttempt,
      isEmailVerified:  req.user.isEmailVerified,
      createdAt:        req.user.createdAt,
      lastLogin:        req.user.lastLogin,
    },
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/refresh
//  Body: { refreshToken }
// ════════════════════════════════════════════════════════════════════════════
exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'Refresh token is required.' });
    }

    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
      );
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Refresh token expired. Please log in again.',
        });
      }
      return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
    }

    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or deactivated.' });
    }

    // Issue new access token only (refresh token stays the same)
    const newToken = signToken(user._id);
    res.json({ success: true, token: newToken });
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/forgot-password
//  Body: { email }
// ════════════════════════════════════════════════════════════════════════════
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // ── Always respond the same way — prevents email enumeration ──────────
    if (!user) {
      return res.json({
        success: true,
        message: 'If an account with that email exists, a reset link has been sent.',
      });
    }

    // ── Guard: Google-only accounts can't use email reset ─────────────────
    if (user.provider === 'google' && !user.password) {
      return res.status(400).json({
        success: false,
        message: 'This account uses Google Sign-In. Please sign in with Google.',
      });
    }

    // ── Generate reset token (plain → stored as hash in DB) ──────────────
    const resetToken = user.createPasswordResetToken();
    await user.save({ validateBeforeSave: false });

    // ── Send email ────────────────────────────────────────────────────────
    try {
      await emailUtil.sendPasswordResetEmail(user.email, user.name, resetToken);
    } catch (emailErr) {
      // Roll back the token if email send fails
      user.passwordResetToken   = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });

      console.error('Password reset email failed:', emailErr.message);
      return res.status(500).json({
        success: false,
        message: 'Could not send reset email. Please try again later.',
      });
    }

    res.json({
      success: true,
      message: 'Password reset link has been sent to your email.',
    });
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/auth/reset-password/:token
//  Body: { password }
//  :token = plain token from the email link (not the hashed DB version)
// ════════════════════════════════════════════════════════════════════════════
exports.resetPassword = async (req, res, next) => {
  try {
    const { token }    = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters.',
      });
    }

    // Hash the URL token to compare with the stored hash
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      passwordResetToken:   hashedToken,
      passwordResetExpires: { $gt: Date.now() }, // not expired
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'This reset link is invalid or has expired. Please request a new one.',
      });
    }

    // ── Set new password and clear token fields ───────────────────────────
    user.password             = password; // hashed by pre-save hook
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    user.lastLogin            = new Date();
    await user.save();

    // Auto-login — return new JWT
    sendAuthResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  PATCH /api/auth/update-password  (protected)
//  Body: { currentPassword, newPassword }
// ════════════════════════════════════════════════════════════════════════════
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Both currentPassword and newPassword are required.',
      });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters.',
      });
    }

    // Fetch user WITH password field
    const user = await User.findById(req.user._id).select('+password');

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: 'Your account uses Google Sign-In. Password update is not applicable.',
      });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword; // hashed by pre-save hook
    await user.save();

    sendAuthResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  PATCH /api/auth/update-profile  (protected)
//  Body: { name?, photoURL? }
// ════════════════════════════════════════════════════════════════════════════
exports.updateProfile = async (req, res, next) => {
  try {
    const { name, photoURL } = req.body;
    const updates = {};

    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Name must be at least 2 characters.' });
      }
      updates.name = name.trim();
    }
    if (photoURL !== undefined) {
      updates.photoURL = photoURL;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'No update fields provided.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    );

    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

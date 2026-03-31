'use strict';

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

// ════════════════════════════════════════════════════════════════════════════
//  TOKEN GENERATORS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sign a short-lived access token (default 7d).
 */
exports.signToken = (userId) =>
  jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

/**
 * Sign a longer-lived refresh token (default 30d).
 */
exports.signRefreshToken = (userId) =>
  jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

// ════════════════════════════════════════════════════════════════════════════
//  PROTECT — required authentication
//  Usage: router.get('/me', protect, controller)
// ════════════════════════════════════════════════════════════════════════════
exports.protect = async (req, res, next) => {
  try {
    let token;

    // 1. Check Authorization: Bearer <token>
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    // 2. Fallback: cookie named "token" (if you add cookie-parser later)
    else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated. Please log in.',
      });
    }

    // Verify signature + expiry
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please log in again.',
          expired: true, // hint for frontend to use refresh token
        });
      }
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }

    // Fetch user — password excluded by default (select: false in schema)
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'The user belonging to this token no longer exists.',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Contact support.',
      });
    }

    req.user = user; // attach to request for downstream handlers
    next();
  } catch (err) {
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  OPTIONAL AUTH — attaches user if valid token present, continues either way
//  Usage: router.get('/feed', optionalAuth, controller)
// ════════════════════════════════════════════════════════════════════════════
exports.optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id);
    }
  } catch (_) {
    // Silently ignore — user stays undefined; route continues as unauthenticated
  }
  next();
};

// ════════════════════════════════════════════════════════════════════════════
//  REQUIRE PREMIUM — must be logged in AND have an active premium subscription
//  Usage: router.get('/unlimited-quiz', protect, requirePremium, controller)
// ════════════════════════════════════════════════════════════════════════════
exports.requirePremium = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }

  const isActive =
    req.user.isPremium &&
    (!req.user.premiumExpiresAt || new Date() < new Date(req.user.premiumExpiresAt));

  if (!isActive) {
    return res.status(403).json({
      success: false,
      message: 'This feature requires a Premium subscription.',
      requiresPremium: true, // hint for frontend to show upgrade modal
    });
  }

  next();
};

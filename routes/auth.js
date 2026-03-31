'use strict';

const express = require('express');
const router  = express.Router();

const {
  register,
  login,
  googleAuth,
  firebaseAuth,        
  getMe,
  refreshToken,
  forgotPassword,
  resetPassword,
  updatePassword,
  updateProfile,
} = require('../controllers/authController');

const { protect } = require('../middleware/auth');

// ════════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES  (no JWT required)
// ════════════════════════════════════════════════════════════════════════════

// Email + Password registration
router.post('/register', register);

// Email + Password login
router.post('/login', login);

// Google Sign-In (send idToken from @react-oauth/google)
router.post('/google', googleAuth);

router.post('/firebase',          firebaseAuth);   // ← ADD THIS LINE


// Forgot password — sends reset email
router.post('/forgot-password', forgotPassword);

// Reset password via token from email
// :token = plain token (URL-safe, not hashed)
router.post('/reset-password/:token', resetPassword);

// Refresh access token using refresh token
router.post('/refresh', refreshToken);

// ════════════════════════════════════════════════════════════════════════════
//  PROTECTED ROUTES  (JWT required via protect middleware)
// ════════════════════════════════════════════════════════════════════════════

// Get current user profile
router.get('/me', protect, getMe);

// Update name / photo URL
router.patch('/update-profile', protect, updateProfile);

// Change password (must know current password)
router.patch('/update-password', protect, updatePassword);

module.exports = router;

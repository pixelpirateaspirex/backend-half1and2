'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const dotenv     = require('dotenv');

dotenv.config();

// ── Validate required env vars on startup ────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`❌  Missing required environment variables: ${missing.join(', ')}`);
  console.error('    Copy .env.example → .env and fill in the values.');
  process.exit(1);
}

const app = express();

// ════════════════════════════════════════════════════════════════════════════
//  FIX 1: Trust Render's reverse proxy so rate-limiters see real client IPs.
//  Without this, every user shares Render's load-balancer IP → the global
//  200-req/15-min cap is hit almost instantly across ALL users combined.
//  Setting trust proxy = 1 tells express-rate-limit to read the real IP
//  from the X-Forwarded-For header that Render's proxy injects.
// ════════════════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);

// ════════════════════════════════════════════════════════════════════════════
//  STRIPE WEBHOOK — must receive raw body BEFORE express.json() parses it
// ════════════════════════════════════════════════════════════════════════════
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }));

// ════════════════════════════════════════════════════════════════════════════
//  GLOBAL MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════════
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  }),
);

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:3001',
  'https://pixelpirate9555-xi.vercel.app',
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin "${origin}" is not allowed`));
    },
    credentials: true,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// ════════════════════════════════════════════════════════════════════════════
//  RATE LIMITING
// ════════════════════════════════════════════════════════════════════════════

// Global limiter — raised to 500 so normal browsing doesn't trigger 429.
// Per-real-IP thanks to trust proxy above.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this IP. Please wait 15 minutes.' },
});
app.use('/api', globalLimiter);

// Auth limiter — tight (stays at 15), these should be rare and slow.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many authentication attempts. Please wait 15 minutes.' },
});
app.use('/api/auth/login',           authLimiter);
app.use('/api/auth/register',        authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// ════════════════════════════════════════════════════════════════════════════
//  FIX 2: Dedicated recommend limiter — replaces the global cap for this
//  route. 4 tabs × reasonable refresh = ~40 req/15 min per user is fine.
//  The backend-side recommendController cache means repeat tab clicks are
//  served instantly without touching this limiter at all.
// ════════════════════════════════════════════════════════════════════════════
const recommendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,                          // 60 recommend calls / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many recommendation requests. Please wait a few minutes.',
    retryAfter: 60,
  },
});

// ════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════════
const authRoutes    = require('./routes/auth');
const listsRoutes   = require('./routes/lists');
const paymentRoutes = require('./routes/payment');
const quizRoutes    = require('./routes/quiz');

const { authMiddleware } = require('./middleware/authMiddleware');
const {
  getRecommendations,
  savePreferences,
  getPreferences,
} = require('./controllers/recommendController');

// ── Auth ──────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Core feature routes ───────────────────────────────────────────────────────
app.use('/api/lists',   listsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/quiz',    quizRoutes);

// ── Onboarding preferences ────────────────────────────────────────────────────
//  GET  /api/preferences   → fetch saved preferences (used on app load to check onboarded)
//  POST /api/preferences   → save preferences after WelcomePage wizard
app.get('/api/preferences',  authMiddleware, getPreferences);
app.post('/api/preferences', authMiddleware, savePreferences);

// ── AI Recommendations (premium) ─────────────────────────────────────────────
//  GET /api/recommend/:type  where type = movies | songs | games | audiobooks
//  recommendLimiter applied BEFORE authMiddleware so bad actors are rejected
//  before we even touch the DB.
app.get('/api/recommend/:type', recommendLimiter, authMiddleware, getRecommendations);

// ════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Pixel Pirates API is sailing! ⚓',
    environment: process.env.NODE_ENV || 'development',
    timestamp:   new Date().toISOString(),
    mongodb:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  404 + GLOBAL ERROR HANDLER
// ════════════════════════════════════════════════════════════════════════════
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route [${req.method}] ${req.originalUrl} not found.`,
  });
});

app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err.message);

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ success: false, message: `An account with that ${field} already exists.` });
  }
  if (err.name === 'ValidationError') {
    const msgs = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: msgs.join('. ') });
  }
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
  }
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, message: err.message });
  }

  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS:          45_000,
  })
  .then(() => {
    console.log('✅  MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('  ⚓  Pixel Pirates Backend');
      console.log(`  🚀  http://localhost:${PORT}`);
      console.log(`  🌍  ${process.env.NODE_ENV || 'development'} mode`);
      console.log(`  📡  Health: http://localhost:${PORT}/api/health`);
      console.log('');
    });
  })
  .catch((err) => {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  });

const shutdown = async (signal) => {
  console.log(`\n${signal} received — shutting down gracefully…`);
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
  } catch (err) {
    console.error('Error closing MongoDB connection:', err.message);
  } finally {
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;

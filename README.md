# Pixel Pirates — Backend API

A Node.js / Express / MongoDB REST API that powers the Pixel Pirates entertainment platform — movies, books, music, AI quizzes, and Stripe Premium subscriptions.

---

## Table of Contents

1. [Stack](#stack)  
2. [Project Structure](#project-structure)  
3. [Environment Variables](#environment-variables)  
4. [Getting Started](#getting-started)  
5. [API Reference](#api-reference)  
6. [Stripe Setup](#stripe-setup)  
7. [Authentication Flow](#authentication-flow)  
8. [Deployment Notes](#deployment-notes)  

---

## Stack

| Layer        | Technology                        |
|--------------|-----------------------------------|
| Runtime      | Node.js 18+                       |
| Framework    | Express 4                         |
| Database     | MongoDB (Mongoose 7)              |
| Auth         | JWT + Firebase Auth (Google SSO)  |
| Payments     | Stripe (Checkout + Webhooks)      |
| Email        | Nodemailer (SMTP / Gmail)         |
| Environment  | dotenv                            |

---

## Project Structure

```
pixel-pirates-backend/
├── controllers/
│   ├── authController.js      ← (First Half) Registration, login, JWT
│   ├── listsController.js     ← Watchlist, Reading List, Songs Heard CRUD
│   ├── paymentController.js   ← Stripe Checkout, Webhook, Subscription
│   └── quizController.js      ← Quiz state, grading, history
├── middleware/
│   └── auth.js                ← JWT verification middleware
├── models/
│   ├── User.js                ← User schema (email, subscription, stripeCustomerId)
│   └── UserData.js            ← Per-user data (watchlist, readingList, etc.)
├── routes/
│   ├── auth.js                ← /api/auth/*
│   ├── lists.js               ← /api/lists/*
│   ├── payment.js             ← /api/payment/*
│   └── quiz.js                ← /api/quiz/*
├── utils/
│   └── email.js               ← Nodemailer helper
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── server.js                  ← Express app entry point
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in every value:

```env
# ── App ──────────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=5000

# ── MongoDB ───────────────────────────────────────────────────────────────────
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/pixel-pirates

# ── JWT ───────────────────────────────────────────────────────────────────────
JWT_SECRET=replace_with_a_long_random_string_min_32_chars
JWT_EXPIRES_IN=7d

# ── Stripe ────────────────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...           # The ₹199/month recurring price ID

# ── Client ────────────────────────────────────────────────────────────────────
CLIENT_URL=http://localhost:3000    # No trailing slash

# ── Email (Nodemailer) ────────────────────────────────────────────────────────
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=pixelpirateaspirex@gmail.com
EMAIL_PASS=your_app_password        # Gmail App Password, not your login password

# ── Admin (dev only) ─────────────────────────────────────────────────────────
ADMIN_SECRET=replace_with_secret_for_quiz_reset_endpoint
```

> **Never commit `.env` to version control.** It is listed in `.gitignore`.

---

## Getting Started

### Prerequisites

- Node.js 18+  
- MongoDB Atlas account (or local MongoDB 6+)  
- Stripe account (test mode is fine for dev)  

### Install & Run

```bash
# 1. Clone and install dependencies
git clone https://github.com/your-org/pixel-pirates-backend.git
cd pixel-pirates-backend
npm install

# 2. Set up environment
cp .env.example .env
# → Edit .env with your real keys

# 3. Start in development (with hot reload)
npm run dev

# 4. Start in production
npm start
```

### Required npm packages (Second Half)

```bash
npm install stripe
```

All other dependencies (`express`, `mongoose`, `jsonwebtoken`, `bcryptjs`, `nodemailer`, `dotenv`, `cors`) should already be installed from the First Half.

---

## API Reference

All protected routes require the header:

```
Authorization: Bearer <jwt_token>
```

### Auth — `/api/auth`

Implemented in the First Half. Provides:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Email/password login |
| POST | `/api/auth/google` | Firebase Google SSO login |
| GET  | `/api/auth/me` | Get current user profile |
| POST | `/api/auth/forgot-password` | Send reset email |
| POST | `/api/auth/reset-password` | Reset with token |

---

### Lists — `/api/lists`

All routes are **protected**.

#### All Lists
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/lists` | Fetch all three lists in one request |

#### Watchlist
| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| GET    | `/api/lists/watchlist` | — | Get watchlist |
| POST   | `/api/lists/watchlist` | `{ imdbID, title, poster, year, genre, rating }` | Add movie |
| PUT    | `/api/lists/watchlist/sync` | `{ items: [...] }` | Bulk sync from client |
| PATCH  | `/api/lists/watchlist/:imdbID/watched` | `{ watched: bool }` | Toggle watched |
| DELETE | `/api/lists/watchlist/:imdbID` | — | Remove movie |

#### Reading List
| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| GET    | `/api/lists/reading` | — | Get reading list |
| POST   | `/api/lists/reading` | `{ title, author, cover, genre, bookLink, status }` | Add book |
| PUT    | `/api/lists/reading/sync` | `{ items: [...] }` | Bulk sync from client |
| PATCH  | `/api/lists/reading/:bookId/status` | `{ status }` | Update status (`Want to Read` \| `Reading` \| `Finished`) |
| DELETE | `/api/lists/reading/:bookId` | — | Remove book |

#### Songs Heard
| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| GET    | `/api/lists/songs` | — | Get songs heard |
| POST   | `/api/lists/songs` | `{ trackId, title, artist, album, art, genre, previewUrl }` | Log song |
| PUT    | `/api/lists/songs/sync` | `{ items: [...] }` | Bulk sync from client |
| DELETE | `/api/lists/songs/:songId` | — | Remove song |

---

### Payment — `/api/payment`

#### Unprotected
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/payment/webhook` | Stripe webhook (raw body) |

#### Protected
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/payment/create-checkout-session` | `{ priceId? }` | Returns Stripe Checkout `{ url }` |
| GET  | `/api/payment/status` | — | Current subscription status |
| GET  | `/api/payment/verify-session?session_id=cs_xxx` | — | Verify after redirect |
| POST | `/api/payment/cancel` | — | Cancel at period end |

##### Checkout Flow (Frontend Integration)

```javascript
// 1. User clicks "Get Premium"
const { url } = await fetch('/api/payment/create-checkout-session', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({})
}).then(r => r.json());

// 2. Redirect to Stripe
window.location.href = url;

// 3. Stripe redirects to CLIENT_URL/payment-success?session_id=cs_xxx
// 4. Frontend calls /api/payment/verify-session?session_id=cs_xxx to confirm
```

---

### Quiz — `/api/quiz`

All routes are **protected**.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET  | `/api/quiz/state` | — | Load user's quiz state |
| GET  | `/api/quiz/questions` | — | Get shuffled questions (no answers) |
| POST | `/api/quiz/submit` | `{ answers: [{ id, answer }] }` | Submit + grade + persist |
| GET  | `/api/quiz/history?page=1&limit=10` | — | Attempt history |
| POST | `/api/quiz/unlock` | — | Unlock after Premium subscription |
| POST | `/api/quiz/reset` | `{ adminSecret, userId? }` | Dev: reset state |

##### Submit Payload Example

```json
{
  "answers": [
    { "id": "q01", "answer": "The Dark Knight" },
    { "id": "q02", "answer": "2026" }
  ]
}
```

##### Submit Response

```json
{
  "success": true,
  "data": {
    "score": 8,
    "total": 10,
    "earned": 80,
    "badge": "🥇 Gold",
    "isPerfect": false,
    "isFirst": true,
    "grantFreePremium": false,
    "totalPoints": 80,
    "quizUnlocked": false,
    "gradedAnswers": [...]
  }
}
```

> **Perfect score on first attempt?**  
> `grantFreePremium: true` is returned. The backend automatically activates a 30-day Premium subscription and sets `quizUnlocked: true`.

---

## Stripe Setup

### 1. Create a Product & Price

In the [Stripe Dashboard](https://dashboard.stripe.com):

1. Go to **Products → Add product**  
2. Name: `Pixel Pirates Premium`  
3. Pricing: **Recurring**, `₹199 INR / month`  
4. Copy the **Price ID** (e.g. `price_1Xyz...`) → paste into `STRIPE_PRICE_ID` in `.env`

### 2. Configure the Webhook

1. Go to **Developers → Webhooks → Add endpoint**  
2. URL: `https://yourdomain.com/api/payment/webhook`  
3. Events to listen for:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
4. Copy the **Signing secret** → paste into `STRIPE_WEBHOOK_SECRET` in `.env`

### 3. Test Locally with Stripe CLI

```bash
# Install Stripe CLI, then:
stripe listen --forward-to localhost:5000/api/payment/webhook

# Use test card: 4242 4242 4242 4242  |  Any future date  |  Any 3-digit CVV
```

---

## Authentication Flow

```
Client                          Server                        Firebase
  │                               │                               │
  ├─── POST /api/auth/google ─────►  Verify Firebase ID Token ───►│
  │         { idToken }           │◄── user info ─────────────────│
  │                               │  Find or create User in DB    │
  │◄── { token, user } ───────────│  Sign JWT                     │
  │                               │                               │
  ├─── GET /api/lists/watchlist   │                               │
  │    Authorization: Bearer <jwt>│                               │
  │                               │  auth middleware verifies JWT │
  │◄── { success, data } ─────────│                               │
```

---

## Deployment Notes

### server.js Mount Order (Critical for Stripe)

The Stripe webhook needs the **raw Buffer body** before `express.json()` parses it. In `server.js`:

```javascript
// 1. Raw body for Stripe — MUST be before express.json()
app.use(
  '/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  require('./controllers/paymentController').handleWebhook
);

// 2. JSON body parser for all other routes
app.use(express.json({ limit: '10mb' }));

// 3. Mount routes
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/lists',   require('./routes/lists'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/quiz',    require('./routes/quiz'));
```

### UserData Model Fields Required

Your `models/UserData.js` must include (at minimum):

```javascript
{
  user:             { type: ObjectId, ref: 'User', unique: true },
  watchlist:        [{ imdbID, title, poster, year, genre, rating, watched, addedAt, watchedAt }],
  readingList:      [{ title, author, cover, genre, bookLink, status, addedAt, statusUpdatedAt }],
  songsHeard:       [{ trackId, title, artist, album, art, genre, previewUrl, playedAt }],
  quizPoints:       { type: Number, default: 0 },
  quizHistory:      [{ score, total, earned, badge, isPerfect, isFirst, gradedAnswers, attemptedAt }],
  quizUnlocked:     { type: Boolean, default: false },
  quizAttempted:    { type: Boolean, default: false },
  firstQuizAttempt: { type: Boolean, default: true },
}
```

### User Model Fields Required

Your `models/User.js` must include:

```javascript
{
  // ... existing auth fields ...
  stripeCustomerId: { type: String, default: '' },
  subscription: {
    status:          { type: String, enum: ['inactive','active','cancelling','past_due','cancelled'], default: 'inactive' },
    plan:            { type: String, default: 'free' },
    stripeSubId:     String,
    stripeSessionId: String,
    stripePriceId:   String,
    orderId:         String,
    type:            String,   // 'stripe' | 'free_earned'
    activatedAt:     Date,
    expiresAt:       Date,
    updatedAt:       Date,
  },
}
```

### Production Checklist

- [ ] `NODE_ENV=production` in environment  
- [ ] Use Stripe **live keys** (not test keys)  
- [ ] Webhook endpoint uses **HTTPS**  
- [ ] MongoDB connection uses TLS / Atlas  
- [ ] `JWT_SECRET` is at least 32 random characters  
- [ ] `ADMIN_SECRET` is set and not exposed publicly  
- [ ] CORS restricted to your frontend domain in `server.js`  
- [ ] Rate limiting enabled (e.g. `express-rate-limit`) on `/api/auth` routes  

---

## License

© 2026 Pixel Pirates. All rights reserved.

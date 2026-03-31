# ⚓ Pixel Pirates Backend — Half 1 of 2

**What's in this half:** Project foundation + complete Authentication system.  
**Half 2 will add:** Lists (watchlist/reading/songs), Stripe payments, Quiz.

---

## 📁 Files in This Half

```
backend/
├── server.js                    ← Express app (auth mounted; half-2 routes commented out)
├── package.json                 ← All dependencies for the full project
├── .env.example                 ← Copy to .env and fill in values
├── .gitignore
│
├── models/
│   ├── User.js                  ← Schema: bcrypt, premium fields, resetToken, virtuals
│   └── UserData.js              ← Schema: watchlist, readingList, songs, quiz, chat
│
├── middleware/
│   └── auth.js                  ← protect / optionalAuth / requirePremium / signToken
│
├── utils/
│   └── email.js                 ← Nodemailer: welcome, password-reset, premium emails
│
├── controllers/
│   └── authController.js        ← register, login, googleAuth, forgot/reset pwd, refresh
│
└── routes/
    └── auth.js                  ← All /api/auth/* endpoints wired up
```

---

## 🚀 Setup in 3 Steps

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Configure environment
```bash
cp .env.example .env
```
Open `.env` and fill in (see sections below for each service):
- `MONGODB_URI`
- `JWT_SECRET` and `JWT_REFRESH_SECRET`
- `GOOGLE_CLIENT_ID`
- `EMAIL_USER` and `EMAIL_PASS`
- `CLIENT_URL`

### Step 3 — Start the server
```bash
npm run dev        # development (nodemon auto-restart)
npm start          # production
```

Verify it works:
```
GET http://localhost:5000/api/health
```

---

## ⚙️ Required Environment Variables

### MongoDB Atlas (free)
1. Go to https://cloud.mongodb.com → Create Free Cluster
2. Database Access → Add user (username + password)
3. Network Access → Add IP → 0.0.0.0/0 (allow all)
4. Connect → Connect your application → copy the URI

```env
MONGODB_URI=mongodb+srv://YOUR_USER:YOUR_PASS@cluster0.xxxxx.mongodb.net/pixel-pirates?retryWrites=true&w=majority
```

### JWT Secrets
Generate two strong secrets (run in terminal):
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
```env
JWT_SECRET=<paste first output here>
JWT_REFRESH_SECRET=<paste second output here>
```

### Google OAuth
1. https://console.cloud.google.com → New Project
2. APIs & Services → OAuth consent screen → External → fill basic info
3. APIs & Services → Credentials → Create → OAuth 2.0 Client ID → Web Application
4. Authorised JS origins: `http://localhost:3000`
5. Authorised redirect URIs: `http://localhost:3000`
```env
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

### Gmail (Nodemailer)
**Do NOT use your regular Gmail password.**  
1. Enable 2-Factor Authentication on your Gmail
2. Google Account → Security → 2-Step Verification → App passwords
3. Select "Mail" and "Other device", click Generate
4. Copy the 16-character password
```env
EMAIL_USER=pixelpirateaspirex@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx    ← the 16-char app password
```

---

## 📡 Auth API Reference

| Method | Endpoint | Auth | Body | Description |
|--------|----------|------|------|-------------|
| `POST` | `/api/auth/register` | ❌ | `{ name, email, password }` | Create account, sends welcome email |
| `POST` | `/api/auth/login` | ❌ | `{ email, password }` | Sign in, returns JWT |
| `POST` | `/api/auth/google` | ❌ | `{ idToken }` | Google Sign-In with ID token |
| `POST` | `/api/auth/forgot-password` | ❌ | `{ email }` | Sends password reset email |
| `POST` | `/api/auth/reset-password/:token` | ❌ | `{ password }` | Reset pwd with email token |
| `POST` | `/api/auth/refresh` | ❌ | `{ refreshToken }` | Get new access token |
| `GET` | `/api/auth/me` | ✅ | — | Get current user |
| `PATCH` | `/api/auth/update-profile` | ✅ | `{ name?, photoURL? }` | Update name/photo |
| `PATCH` | `/api/auth/update-password` | ✅ | `{ currentPassword, newPassword }` | Change password |

All protected routes need: `Authorization: Bearer <token>` header.

---

## 🔄 Auth Flow Diagrams

### Email Registration
```
POST /register { name, email, password }
  → validate input
  → check duplicate email
  → create User (bcrypt hashes pwd in pre-save)
  → create UserData doc
  → send welcome email (async, non-blocking)
  → return { token, refreshToken, user }
```

### Google Sign-In
```
Frontend: uses @react-oauth/google → gets idToken
POST /google { idToken }
  → verify idToken with Google OAuth2Client
  → find user by googleId OR email
  → create if new (send welcome email)
  → return { token, refreshToken, user }
```

### Forgot Password
```
POST /forgot-password { email }
  → find user
  → createPasswordResetToken() → stores SHA-256 hash in DB
  → sends email with: CLIENT_URL/reset-password/<plain_token>
  → return success (same response even if email not found)

POST /reset-password/<plain_token> { password }
  → SHA-256 hash the token from URL
  → find user where hash matches AND not expired
  → set new password (hashed by pre-save hook)
  → clear token fields
  → auto-login → return { token, refreshToken, user }
```

### Token Refresh
```
Access token expires (7d)
POST /refresh { refreshToken }
  → verify refresh token (30d expiry)
  → return new access token
```

---

## 🧪 Quick Test with curl

```bash
# 1. Register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Pixel Pirate","email":"test@example.com","password":"password123"}'

# 2. Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
# → copy the token from the response

# 3. Get current user (replace TOKEN below)
curl http://localhost:5000/api/auth/me \
  -H "Authorization: Bearer TOKEN"

# 4. Forgot password
curl -X POST http://localhost:5000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
```

---

## 📦 Frontend Integration Snippet (Axios)

```js
// src/api/axios.js
import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:5000/api' });

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('pp_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refresh = localStorage.getItem('pp_refresh');
      if (refresh) {
        try {
          const { data } = await api.post('/auth/refresh', { refreshToken: refresh });
          localStorage.setItem('pp_token', data.token);
          original.headers.Authorization = `Bearer ${data.token}`;
          return api(original);
        } catch {
          // Refresh failed → force logout
          localStorage.removeItem('pp_token');
          localStorage.removeItem('pp_refresh');
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(err);
  }
);

export default api;
```

---

## ➡️ What's in Half 2

When Half 2 is ready, you'll add these files and **uncomment 4 lines in server.js**:

```js
// In server.js — uncomment these:
const listsRoutes   = require('./routes/lists');
const paymentRoutes = require('./routes/payment');
const quizRoutes    = require('./routes/quiz');
app.use('/api/lists',   listsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/quiz',    quizRoutes);
```

Half 2 files:
- `controllers/listsController.js` — watchlist / reading list / songs CRUD
- `controllers/paymentController.js` — Stripe checkout + webhook + subscription
- `controllers/quizController.js` — questions, submit, scoring, history
- `routes/lists.js`, `routes/payment.js`, `routes/quiz.js`

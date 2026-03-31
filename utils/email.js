'use strict';

const nodemailer = require('nodemailer');

// ════════════════════════════════════════════════════════════════════════════
//  TRANSPORTER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh transporter each time we send.
 * Nodemailer reuses the SMTP connection pool internally.
 */
function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true', // true only for port 465
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  BASE SENDER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Low-level email sender.
 * @param {Object} opts - { to, subject, html, text }
 */
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('⚠️  Email not configured (EMAIL_USER / EMAIL_PASS missing). Skipping send.');
    return null;
  }

  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from:    process.env.EMAIL_FROM || `"Pixel Pirates" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text:    text || '',
    html:    html || '',
  });

  console.log(`📧  Email sent → ${to} | MessageId: ${info.messageId}`);
  return info;
}

// ════════════════════════════════════════════════════════════════════════════
//  HTML BASE TEMPLATE
// ════════════════════════════════════════════════════════════════════════════
function baseTemplate(bodyContent) {
  const year      = new Date().getFullYear();
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Pixel Pirates</title>
<style>
  *   { margin:0; padding:0; box-sizing:border-box; }
  body{ font-family:'Segoe UI',Arial,sans-serif; background:#07101f; color:#eef2f9; }
  .wrapper  { max-width:580px; margin:40px auto; background:#0f1a2e;
              border:1px solid rgba(255,255,255,0.09); border-radius:16px; overflow:hidden; }
  .header   { background:linear-gradient(135deg,#0d1929,#111d30); padding:2rem;
              text-align:center; border-bottom:1px solid rgba(245,197,66,0.2); }
  .logo     { font-size:1.7rem; font-weight:800; color:#f5c542; letter-spacing:-0.5px; }
  .logo-sub { font-size:0.68rem; color:#7c8fa6; letter-spacing:0.1em;
              text-transform:uppercase; margin-top:0.3rem; }
  .body     { padding:2rem 2.4rem; }
  .body h2  { font-size:1.4rem; color:#f5c542; margin-bottom:1rem; }
  .body p   { color:#b0bfcc; line-height:1.85; margin-bottom:0.9rem; font-size:0.95rem; }
  .body ul  { color:#b0bfcc; line-height:2.1; padding-left:1.2rem;
              margin-bottom:1rem; font-size:0.92rem; }
  .btn-wrap { text-align:center; margin:1.5rem 0; }
  .btn      { display:inline-block; padding:0.85rem 2.2rem;
              background:linear-gradient(135deg,#f5c542,#ffd97a);
              color:#07101f; font-weight:700; font-size:0.95rem;
              border-radius:2rem; text-decoration:none; }
  .info-box { background:rgba(245,197,66,0.06);
              border:1px solid rgba(245,197,66,0.18); border-radius:10px;
              padding:1rem 1.2rem; margin:1.2rem 0; }
  .info-box p { margin:0; color:#eef2f9 !important; font-size:0.88rem !important; }
  .info-box p + p { margin-top:0.4rem; }
  .info-box strong { color:#f5c542; }
  .divider  { height:1px; background:rgba(255,255,255,0.07); margin:1.4rem 0; }
  .link-box { background:rgba(0,0,0,0.2); border-radius:8px; padding:0.7rem 0.9rem;
              font-size:0.78rem; color:#7c8fa6; word-break:break-all; }
  .link-box a { color:#f5c542; text-decoration:none; }
  .warning  { background:rgba(239,68,68,0.07);
              border:1px solid rgba(239,68,68,0.2); border-radius:8px;
              padding:0.75rem 1rem; font-size:0.8rem; color:#fca5a5;
              margin-top:1rem; }
  .success  { background:rgba(16,185,129,0.07);
              border:1px solid rgba(16,185,129,0.2); border-radius:8px;
              padding:0.75rem 1rem; font-size:0.8rem; color:#6ee7b7; }
  .footer   { background:rgba(0,0,0,0.25); padding:1.2rem 2rem;
              text-align:center; font-size:0.72rem; color:#566075; }
  .footer a { color:#f5c542; text-decoration:none; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="logo">⚓ Pixel Pirates</div>
    <div class="logo-sub">Your World, Our Pixels</div>
  </div>
  <div class="body">${bodyContent}</div>
  <div class="footer">
    © ${year} Pixel Pirates &nbsp;·&nbsp;
    <a href="${clientUrl}">Visit Site</a> &nbsp;·&nbsp;
    UIT-RGPV, Bhopal, Madhya Pradesh
  </div>
</div>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  1. WELCOME EMAIL — sent on successful registration
// ════════════════════════════════════════════════════════════════════════════
exports.sendWelcomeEmail = async (to, name) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

  const html = baseTemplate(`
    <h2>Welcome Aboard, ${name}! 🏴‍☠️</h2>
    <p>You've joined the Pixel Pirates crew — we're thrilled to have you!</p>
    <p>Here's everything you can do on the platform:</p>
    <ul>
      <li>🎬 Discover &amp; track <strong>Movies</strong> in your Watchlist</li>
      <li>📚 Build a personal <strong>Reading List</strong></li>
      <li>🎵 Explore <strong>Music</strong> &amp; log songs you've heard</li>
      <li>🎙️ Listen to <strong>Podcasts</strong> &amp; <strong>Audiobooks</strong></li>
      <li>🎮 Browse <strong>Games</strong> by category</li>
      <li>🎪 Find <strong>Events</strong> happening across India</li>
      <li>🧠 Take our <strong>AI-powered Quiz</strong> (ace it for free Premium!)</li>
    </ul>
    <div class="btn-wrap">
      <a class="btn" href="${clientUrl}">Start Exploring ⚓</a>
    </div>
    <div class="success">
      ✅ Your account is fully set up and ready to go.
    </div>
  `);

  return sendEmail({
    to,
    subject: '⚓ Welcome to Pixel Pirates — You\'re in the Crew!',
    html,
    text: `Welcome to Pixel Pirates, ${name}! Start exploring at ${clientUrl}`,
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  2. PASSWORD RESET EMAIL — sent from forgotPassword controller
// ════════════════════════════════════════════════════════════════════════════
exports.sendPasswordResetEmail = async (to, name, resetToken) => {
  const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;

  const html = baseTemplate(`
    <h2>Reset Your Password 🔐</h2>
    <p>Ahoy, <strong>${name}</strong>!</p>
    <p>
      We received a request to reset the password for your Pixel Pirates account.
      Click the button below — this link is valid for <strong>10 minutes only</strong>.
    </p>
    <div class="btn-wrap">
      <a class="btn" href="${resetUrl}">Reset My Password</a>
    </div>
    <div class="divider"></div>
    <p>Or paste this URL into your browser:</p>
    <div class="link-box">
      <a href="${resetUrl}">${resetUrl}</a>
    </div>
    <div class="warning">
      ⚠️ If you didn't request a password reset, please ignore this email.
      Your password will remain unchanged.
    </div>
  `);

  return sendEmail({
    to,
    subject: '🔐 Reset Your Pixel Pirates Password',
    html,
    text: `Reset your Pixel Pirates password: ${resetUrl}\n\nThis link expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  3. PREMIUM ACTIVATED EMAIL — sent after successful Stripe payment
// ════════════════════════════════════════════════════════════════════════════
exports.sendPremiumActivatedEmail = async (to, name, orderId, planType) => {
  const clientUrl   = process.env.CLIENT_URL || 'http://localhost:3000';
  const isFree      = planType === 'free_earned';
  const typeLabel   = isFree ? '🎁 Free Month (Perfect Quiz Score!)' : '💳 Monthly Subscription';

  const html = baseTemplate(`
    <h2>You're Premium Now! 👑</h2>
    <p>Congratulations, <strong>${name}</strong>! Your Pixel Pirates Premium is now active.</p>
    <div class="info-box">
      <p><strong>Plan:</strong> Premium Monthly</p>
      <p><strong>Type:</strong> ${typeLabel}</p>
      ${orderId ? `<p><strong>Order ID:</strong> <code style="font-family:monospace;color:#eef2f9">${orderId}</code></p>` : ''}
      <p><strong>Duration:</strong> 30 days from today</p>
    </div>
    <p>You now have access to:</p>
    <ul>
      <li>♾️ Unlimited AI-powered quizzes</li>
      <li>🎯 Personalised recommendations</li>
      <li>🚫 Ad-free experience</li>
      <li>⚡ Early access to new features</li>
      <li>🛡️ Priority support</li>
    </ul>
    <div class="btn-wrap">
      <a class="btn" href="${clientUrl}">Start Enjoying Premium ⚓</a>
    </div>
    <div class="success">
      ✅ Your subscription is active. Thank you for supporting Pixel Pirates!
    </div>
  `);

  return sendEmail({
    to,
    subject: '👑 Premium Activated — Welcome to the Inner Crew!',
    html,
    text: `Your Pixel Pirates Premium is active, ${name}! Order: ${orderId || 'N/A'}. Visit ${clientUrl}`,
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  RAW SEND — exposed for future use (e.g. contact form forwarding)
// ════════════════════════════════════════════════════════════════════════════
exports.sendEmail = sendEmail;

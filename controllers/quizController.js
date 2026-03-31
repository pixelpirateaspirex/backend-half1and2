'use strict';

/**
 * controllers/quizController.js
 *
 * Handles:
 *   - GET  /api/quiz/state          — load persisted quiz state for the user
 *   - POST /api/quiz/submit         — submit answers, calculate score, persist history
 *   - POST /api/quiz/unlock         — unlock quiz via Premium (mirrors payment activation)
 *   - GET  /api/quiz/history        — paginated attempt history
 *   - POST /api/quiz/reset          — admin/dev: reset a user's quiz state (guarded)
 *
 * The quiz questions are defined in a separate seed file or fetched from AI.
 * This controller manages PERSISTENCE ONLY — question generation happens client-side
 * or via a separate AI route to keep this controller lightweight and testable.
 */

const UserData = require('../models/UserData');
const User     = require('../models/User');

// ─── Question Bank ───────────────────────────────────────────────────────────
// In production you'd move this to a DB collection or a CMS.
// Keeping it here makes the backend self-contained as requested.

const QUESTION_BANK = [
  {
    id: 'q01',
    text: 'Which 2008 film features Heath Ledger as an iconic villain?',
    options: ['Batman Begins', 'The Dark Knight', 'Watchmen', 'V for Vendetta'],
    correct: 'The Dark Knight',
    category: 'movies',
  },
  {
    id: 'q02',
    text: "In what year was Pixel Pirates founded?",
    options: ['2022', '2024', '2025', '2026'],
    correct: '2026',
    category: 'general',
  },
  {
    id: 'q03',
    text: "Who directed 'Inception' (2010)?",
    options: ['Ridley Scott', 'James Cameron', 'Steven Spielberg', 'Christopher Nolan'],
    correct: 'Christopher Nolan',
    category: 'movies',
  },
  {
    id: 'q04',
    text: 'Which platform does Pixel Pirates specialise in?',
    options: [
      'Film Production',
      'Audio Stories',
      'Digital Marketing and Social Media',
      'All of the above',
    ],
    correct: 'All of the above',
    category: 'general',
  },
  {
    id: 'q05',
    text: "When was 'The Shawshank Redemption' released?",
    options: ['1991', '1993', '1994', '1996'],
    correct: '1994',
    category: 'movies',
  },
  {
    id: 'q06',
    text: 'How does Pixel Pirates use technology to enhance storytelling?',
    options: [
      'By using AI and data analytics for personalised content',
      'By focusing only on traditional TV ads',
      'By outsourcing all production work',
      'By avoiding digital platforms',
    ],
    correct: 'By using AI and data analytics for personalised content',
    category: 'general',
  },
  {
    id: 'q07',
    text: 'Which film is about wrestler Mahavir Singh Phogat?',
    options: ['Sultan', 'Bhaag Milkha Bhaag', 'Dangal', 'Mary Kom'],
    correct: 'Dangal',
    category: 'movies',
  },
  {
    id: 'q08',
    text: "What is the primary focus of Pixel Pirates' creative vision?",
    options: [
      'Delivering high-quality, immersive entertainment experiences',
      'Focusing solely on niche indie films',
      'Producing only corporate advertisements',
      'Specialising in live theater only',
    ],
    correct: 'Delivering high-quality, immersive entertainment experiences',
    category: 'general',
  },
  {
    id: 'q09',
    text: "What fictional planet features in 'Avatar' (2009)?",
    options: ['Tatooine', 'Pandora', 'Endor', 'Krypton'],
    correct: 'Pandora',
    category: 'movies',
  },
  {
    id: 'q10',
    text: 'How does Pixel Pirates aim to engage its global audience?',
    options: [
      'By partnering with international streaming platforms',
      'By limiting content to local markets',
      'By avoiding social media promotion',
      'By creating only printed media content',
    ],
    correct: 'By partnering with international streaming platforms',
    category: 'general',
  },
];

const TOTAL_QUESTIONS = QUESTION_BANK.length; // 10

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcBadge(score, total) {
  const pct = score / total;
  if (pct === 1)   return '🥇 Gold';
  if (pct >= 0.8)  return '🥇 Gold';
  if (pct >= 0.5)  return '🥈 Silver';
  return '🥉 Bronze';
}

async function getUserData(userId) {
  let doc = await UserData.findOne({ user: userId });
  if (!doc) {
    doc = await UserData.create({
      user:             userId,
      watchlist:        [],
      readingList:      [],
      songsHeard:       [],
      quizPoints:       0,
      quizHistory:      [],
      quizUnlocked:     false,
      quizAttempted:    false,
      firstQuizAttempt: true,
    });
  }
  return doc;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/quiz/state
 * Returns current quiz state so the frontend can sync with the DB on login.
 */
exports.getQuizState = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);

    // Also peek at subscription status from User document
    const user       = await User.findById(req.user.id).select('subscription');
    const subActive  =
      user?.subscription?.status === 'active' &&
      user?.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date();

    // If subscription is active, ensure quizUnlocked is synced
    if (subActive && !doc.quizUnlocked) {
      doc.quizUnlocked = true;
      await doc.save();
    }

    res.json({
      success: true,
      data: {
        quizPoints:       doc.quizPoints,
        quizUnlocked:     doc.quizUnlocked || subActive,
        quizAttempted:    doc.quizAttempted,
        firstQuizAttempt: doc.firstQuizAttempt,
        totalQuestions:   TOTAL_QUESTIONS,
        historyCount:     doc.quizHistory?.length || 0,
      },
    });
  } catch (err) {
    console.error('[getQuizState]', err);
    res.status(500).json({ success: false, message: 'Server error fetching quiz state.' });
  }
};

/**
 * GET /api/quiz/questions
 * Returns the shuffled question set (answers are not sent — validated server-side on submit).
 * This prevents client-side answer inspection from the network tab.
 */
exports.getQuestions = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);

    // Enforce lock: non-premium users who have already attempted cannot start again
    if (doc.quizAttempted && !doc.quizUnlocked) {
      return res.status(403).json({
        success: false,
        message: 'Quiz is locked. Upgrade to Premium to retry.',
        locked:  true,
      });
    }

    // Send questions WITHOUT the `correct` field
    const questions = QUESTION_BANK.map(({ id, text, options, category }) => ({
      id,
      text,
      options: shuffle([...options]), // shuffle option order per request
      category,
    }));

    res.json({ success: true, data: questions });
  } catch (err) {
    console.error('[getQuestions]', err);
    res.status(500).json({ success: false, message: 'Server error loading questions.' });
  }
};

/**
 * POST /api/quiz/submit
 *
 * Body: { answers: [ { id: 'q01', answer: 'The Dark Knight' }, ... ] }
 *
 * Validates answers server-side, calculates score, persists result.
 */
exports.submitQuiz = async (req, res) => {
  try {
    const { answers } = req.body;

    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ success: false, message: 'answers array is required.' });
    }

    const doc = await getUserData(req.user.id);

    // Enforce lock
    if (doc.quizAttempted && !doc.quizUnlocked) {
      return res.status(403).json({
        success: false,
        message: 'Quiz is locked. Upgrade to Premium to retry.',
        locked:  true,
      });
    }

    // ── Server-side grading ──────────────────────────────────────────────────
    const questionMap = Object.fromEntries(QUESTION_BANK.map((q) => [q.id, q]));

    let score = 0;
    const gradedAnswers = answers.map((a) => {
      const q       = questionMap[a.id];
      if (!q) return { id: a.id, answer: a.answer, correct: null, isCorrect: false };
      const isCorrect = q.correct === a.answer;
      if (isCorrect) score++;
      return {
        id:         a.id,
        question:   q.text,
        answer:     a.answer,
        correct:    q.correct,
        isCorrect,
      };
    });

    const total      = QUESTION_BANK.length;
    const earned     = score * 10;
    const isPerfect  = score === total;
    const isFirst    = doc.firstQuizAttempt;
    const badge      = calcBadge(score, total);

    // ── Persist ──────────────────────────────────────────────────────────────
    doc.quizPoints += earned;
    doc.quizAttempted    = true;
    doc.firstQuizAttempt = false;

    const attempt = {
      score,
      total,
      earned,
      badge,
      isPerfect,
      isFirst,
      gradedAnswers,
      attemptedAt: new Date(),
    };

    doc.quizHistory.unshift(attempt);
    doc.quizHistory = doc.quizHistory.slice(0, 50); // keep last 50 attempts

    // Free Premium: perfect on first try
    let grantFreePremium = false;
    if (isFirst && isPerfect) {
      doc.quizUnlocked = true;
      grantFreePremium = true;

      // Also activate on User document
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // +30 days
      await User.findByIdAndUpdate(req.user.id, {
        'subscription.status':      'active',
        'subscription.plan':        'premium',
        'subscription.activatedAt': new Date(),
        'subscription.expiresAt':   expiresAt,
        'subscription.updatedAt':   new Date(),
        'subscription.orderId':     'PP-FREE-' + req.user.id.toString().slice(-6).toUpperCase(),
        'subscription.type':        'free_earned',
      });
    }

    await doc.save();

    res.json({
      success: true,
      data: {
        score,
        total,
        earned,
        badge,
        isPerfect,
        isFirst,
        grantFreePremium,   // tells frontend to show the "free premium" modal
        totalPoints:   doc.quizPoints,
        quizUnlocked:  doc.quizUnlocked,
        gradedAnswers,
      },
    });
  } catch (err) {
    console.error('[submitQuiz]', err);
    res.status(500).json({ success: false, message: 'Server error submitting quiz.' });
  }
};

/**
 * GET /api/quiz/history
 * Returns the user's attempt history (paginated).
 * Query params: ?page=1&limit=10
 */
exports.getQuizHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;

    const doc = await getUserData(req.user.id);

    const total   = doc.quizHistory.length;
    const history = doc.quizHistory.slice(skip, skip + limit).map((h) => ({
      score:       h.score,
      total:       h.total,
      earned:      h.earned,
      badge:       h.badge,
      isPerfect:   h.isPerfect,
      isFirst:     h.isFirst,
      attemptedAt: h.attemptedAt,
    }));

    res.json({
      success: true,
      data: {
        history,
        quizPoints:  doc.quizPoints,
        quizUnlocked: doc.quizUnlocked,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err) {
    console.error('[getQuizHistory]', err);
    res.status(500).json({ success: false, message: 'Server error fetching quiz history.' });
  }
};

/**
 * POST /api/quiz/unlock
 * Manually unlock the quiz for a user who has just subscribed via
 * an in-app payment flow (if not using Stripe webhooks).
 * Protected — requires a valid JWT AND an active subscription.
 */
exports.unlockQuiz = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('subscription');

    const subActive =
      user?.subscription?.status === 'active' &&
      user?.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date();

    if (!subActive) {
      return res.status(402).json({
        success: false,
        message: 'An active Premium subscription is required to unlock the quiz.',
      });
    }

    const doc = await getUserData(req.user.id);
    doc.quizUnlocked = true;
    await doc.save();

    res.json({ success: true, message: 'Quiz unlocked!', quizUnlocked: true });
  } catch (err) {
    console.error('[unlockQuiz]', err);
    res.status(500).json({ success: false, message: 'Server error unlocking quiz.' });
  }
};

/**
 * POST /api/quiz/reset  (dev / admin only — guard with ADMIN_SECRET)
 * Resets quiz state for a user. Use in dev/testing only.
 *
 * Body: { adminSecret, userId? }  (userId defaults to req.user.id)
 */
exports.resetQuiz = async (req, res) => {
  try {
    const { adminSecret, userId } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const targetId = userId || req.user.id;
    const doc      = await getUserData(targetId);

    doc.quizPoints       = 0;
    doc.quizHistory      = [];
    doc.quizUnlocked     = false;
    doc.quizAttempted    = false;
    doc.firstQuizAttempt = true;
    await doc.save();

    res.json({ success: true, message: `Quiz state reset for user ${targetId}.` });
  } catch (err) {
    console.error('[resetQuiz]', err);
    res.status(500).json({ success: false, message: 'Server error resetting quiz.' });
  }
};

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

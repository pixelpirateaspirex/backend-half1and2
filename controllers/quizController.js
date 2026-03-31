'use strict';

/**
 * controllers/quizController.js
 *
 * FIX SUMMARY:
 *  1. getUserData used { user: userId } but UserData schema field is `userId` → fixed
 *  2. doc.quizHistory → doc.quizAttempts (schema field name)
 *  3. doc.firstQuizAttempt / doc.quizAttempted don't exist in UserData schema →
 *     replaced with derived logic from quizAttempts array length
 *  4. gradedAnswers not in QuizAttemptSchema → quiz submit now stores safe subset
 */

const UserData = require('../models/UserData');
const User     = require('../models/User');

// ─── Question Bank ───────────────────────────────────────────────────────────
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

const TOTAL_QUESTIONS = QUESTION_BANK.length;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcBadge(score, total) {
  const pct = score / total;
  if (pct >= 0.8)  return '🥇 Gold';
  if (pct >= 0.5)  return '🥈 Silver';
  return '🥉 Bronze';
}

// FIX 1: was { user: userId } — UserData schema uses `userId` field
async function getUserData(userId) {
  let doc = await UserData.findOne({ userId });
  if (!doc) {
    doc = await UserData.create({ userId });
  }
  return doc;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /api/quiz/state
 */
exports.getQuizState = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);

    const user      = await User.findById(req.user.id).select('subscription');
    const subActive =
      user?.subscription?.status === 'active' &&
      user?.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date();

    // FIX 2: quizUnlocked lives on UserData; sync from subscription if needed
    if (subActive && !doc.quizUnlocked) {
      doc.quizUnlocked = true;
      await doc.save();
    }

    // FIX 3: derive attempt flags from quizAttempts array (not missing fields)
    const attemptCount   = doc.quizAttempts?.length || 0;
    const quizAttempted  = attemptCount > 0;
    const firstQuizAttempt = !quizAttempted;

    res.json({
      success: true,
      data: {
        quizPoints:       doc.quizPoints      || 0,
        quizUnlocked:     doc.quizUnlocked    || subActive || false,
        quizAttempted,
        firstQuizAttempt,
        totalQuestions:   TOTAL_QUESTIONS,
        historyCount:     attemptCount,
      },
    });
  } catch (err) {
    console.error('[getQuizState]', err);
    res.status(500).json({ success: false, message: 'Server error fetching quiz state.' });
  }
};

/**
 * GET /api/quiz/questions
 */
exports.getQuestions = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);

    // FIX 3: derive quizAttempted from array
    const quizAttempted = (doc.quizAttempts?.length || 0) > 0;

    if (quizAttempted && !doc.quizUnlocked) {
      return res.status(403).json({
        success: false,
        message: 'Quiz is locked. Upgrade to Premium to retry.',
        locked:  true,
      });
    }

    const questions = QUESTION_BANK.map(({ id, text, options, category }) => ({
      id,
      text,
      options: shuffle([...options]),
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
 * Body: { answers: [ { id: 'q01', answer: 'The Dark Knight' }, ... ] }
 */
exports.submitQuiz = async (req, res) => {
  try {
    const { answers } = req.body;

    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ success: false, message: 'answers array is required.' });
    }

    const doc = await getUserData(req.user.id);

    // FIX 3: derive from array
    const quizAttempted = (doc.quizAttempts?.length || 0) > 0;
    const isFirst       = !quizAttempted;

    if (quizAttempted && !doc.quizUnlocked) {
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
      const q = questionMap[a.id];
      if (!q) return { id: a.id, answer: a.answer, correct: null, isCorrect: false };
      const isCorrect = q.correct === a.answer;
      if (isCorrect) score++;
      return { id: a.id, question: q.text, answer: a.answer, correct: q.correct, isCorrect };
    });

    const total     = QUESTION_BANK.length;
    const earned    = score * 10;
    const isPerfect = score === total;
    const badge     = calcBadge(score, total);

    // FIX 4: Only store fields that exist in QuizAttemptSchema
    // (gradedAnswers is NOT in schema — returned to client only, not persisted)
    const attempt = {
      score,
      total,
      earned,
      badge,
      isPerfect,
      isFirst,
      ts: new Date(),
    };

    // FIX 2: use quizAttempts (correct field name from UserData schema)
    if (!doc.quizAttempts) doc.quizAttempts = [];
    doc.quizAttempts.unshift(attempt);
    doc.quizAttempts = doc.quizAttempts.slice(0, 50);

    // FIX 5: quizPoints field exists in schema
    if (!doc.quizPoints) doc.quizPoints = 0;
    doc.quizPoints += earned;

    // Free Premium: perfect on first try
    let grantFreePremium = false;
    if (isFirst && isPerfect) {
      doc.quizUnlocked = true;
      grantFreePremium = true;

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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
        grantFreePremium,
        totalPoints:  doc.quizPoints,
        quizUnlocked: doc.quizUnlocked || false,
        gradedAnswers, // returned to client but NOT stored in DB
      },
    });
  } catch (err) {
    console.error('[submitQuiz]', err);
    res.status(500).json({ success: false, message: 'Server error submitting quiz.' });
  }
};

/**
 * GET /api/quiz/history
 */
exports.getQuizHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip  = (page - 1) * limit;

    const doc = await getUserData(req.user.id);

    // FIX 2: quizAttempts not quizHistory
    const attempts = doc.quizAttempts || [];
    const total    = attempts.length;
    const history  = attempts.slice(skip, skip + limit).map((h) => ({
      score:       h.score,
      total:       h.total,
      earned:      h.earned,
      badge:       h.badge,
      isPerfect:   h.isPerfect,
      isFirst:     h.isFirst,
      attemptedAt: h.ts,
    }));

    res.json({
      success: true,
      data: {
        history,
        quizPoints:   doc.quizPoints   || 0,
        quizUnlocked: doc.quizUnlocked || false,
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
 * POST /api/quiz/reset  (dev / admin only)
 */
exports.resetQuiz = async (req, res) => {
  try {
    const { adminSecret, userId } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const targetId = userId || req.user.id;
    const doc      = await getUserData(targetId);

    // FIX 2: reset correct field name
    doc.quizPoints   = 0;
    doc.quizAttempts = [];
    doc.quizUnlocked = false;
    await doc.save();

    res.json({ success: true, message: `Quiz state reset for user ${targetId}.` });
  } catch (err) {
    console.error('[resetQuiz]', err);
    res.status(500).json({ success: false, message: 'Server error resetting quiz.' });
  }
};

// ─── Utility ─────────────────────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

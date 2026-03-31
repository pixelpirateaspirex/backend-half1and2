'use strict';

/**
 * routes/quiz.js
 * Mount in server.js:  app.use('/api/quiz', require('./routes/quiz'));
 */

const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const qc      = require('../controllers/quizController');

// Persistent state for the logged-in user
router.get ('/state',     auth, qc.getQuizState);

// Fetch shuffled questions (correct answers withheld)
router.get ('/questions', auth, qc.getQuestions);

// Submit answers → server-side grading + persistence
router.post('/submit',    auth, qc.submitQuiz);

// Attempt history (paginated)
router.get ('/history',   auth, qc.getQuizHistory);

// Unlock quiz after Premium activation
router.post('/unlock',    auth, qc.unlockQuiz);

// Dev/admin reset — also requires auth so the JWT middleware validates the token
router.post('/reset',     auth, qc.resetQuiz);

module.exports = router;

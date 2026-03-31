'use strict';

/**
 * routes/lists.js
 * Mount in server.js:  app.use('/api/lists', require('./routes/lists'));
 * All routes require a valid JWT (auth middleware).
 */

const express = require('express');
const router  = express.Router();
const { protect: auth } = require('../middleware/auth');
const lc      = require('../controllers/listsController');

// ─── Convenience: fetch all three lists in one shot ─────────────────────────
router.get('/', auth, lc.getAllLists);

// ─── Watchlist ───────────────────────────────────────────────────────────────
router.get   ('/watchlist',                    auth, lc.getWatchlist);
router.post  ('/watchlist',                    auth, lc.addToWatchlist);
router.put   ('/watchlist/sync',               auth, lc.syncWatchlist);
router.patch ('/watchlist/:imdbID/watched',    auth, lc.toggleWatched);
router.delete('/watchlist/:imdbID',            auth, lc.removeFromWatchlist);

// ─── Reading List ────────────────────────────────────────────────────────────
router.get   ('/reading',                      auth, lc.getReadingList);
router.post  ('/reading',                      auth, lc.addToReadingList);
router.put   ('/reading/sync',                 auth, lc.syncReadingList);
router.patch ('/reading/:bookId/status',       auth, lc.updateReadingStatus);
router.delete('/reading/:bookId',              auth, lc.removeFromReadingList);

// ─── Songs Heard ─────────────────────────────────────────────────────────────
router.get   ('/songs',                        auth, lc.getSongsHeard);
router.post  ('/songs',                        auth, lc.addSongHeard);
router.put   ('/songs/sync',                   auth, lc.syncSongsHeard);
router.delete('/songs/:songId',                auth, lc.removeSongHeard);

module.exports = router;

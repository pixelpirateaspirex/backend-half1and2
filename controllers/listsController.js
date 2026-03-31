'use strict';

/**
 * controllers/listsController.js
 * Full CRUD for user lists: watchlist, readingList, songsHeard
 * All routes are protected by auth middleware (req.user is populated)
 */

const UserData = require('../models/UserData');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch or lazily create the UserData document for the authenticated user.
 */
async function getUserData(userId) {
  let doc = await UserData.findOne({ user: userId });
  if (!doc) {
    doc = await UserData.create({
      user: userId,
      watchlist: [],
      readingList: [],
      songsHeard: [],
      quizPoints: 0,
      quizHistory: [],
      quizUnlocked: false,
      quizAttempted: false,
      firstQuizAttempt: true,
    });
  }
  return doc;
}

/** Trim a string field — avoids stored XSS noise */
function trim(val, max = 500) {
  return typeof val === 'string' ? val.slice(0, max).trim() : '';
}

// ─── WATCHLIST ───────────────────────────────────────────────────────────────

/**
 * GET /api/lists/watchlist
 * Returns the full watchlist for the current user.
 */
exports.getWatchlist = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[getWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error fetching watchlist.' });
  }
};

/**
 * POST /api/lists/watchlist
 * Add a movie to the watchlist (idempotent — ignores duplicates by imdbID or title).
 *
 * Body: { imdbID, title, poster, year, genre, rating }
 */
exports.addToWatchlist = async (req, res) => {
  try {
    const { imdbID, title, poster, year, genre, rating } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required.' });
    }

    const doc = await getUserData(req.user.id);

    // Dedup check — match on imdbID when available, else on title
    const isDupe = doc.watchlist.some(
      (m) => (imdbID && m.imdbID === imdbID) || m.title === title
    );
    if (isDupe) {
      return res.status(409).json({ success: false, message: 'Already in watchlist.' });
    }

    const entry = {
      imdbID:    trim(imdbID, 20),
      title:     trim(title, 200),
      poster:    trim(poster, 500),
      year:      trim(year, 10),
      genre:     trim(genre, 100),
      rating:    trim(String(rating || ''), 10),
      watched:   false,
      addedAt:   new Date(),
      watchedAt: null,
    };

    doc.watchlist.unshift(entry);
    await doc.save();

    res.status(201).json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[addToWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error adding to watchlist.' });
  }
};

/**
 * PATCH /api/lists/watchlist/:imdbID/watched
 * Toggle the watched flag on a watchlist entry.
 *
 * Body: { watched: boolean }
 */
exports.toggleWatched = async (req, res) => {
  try {
    const { imdbID } = req.params;
    const doc = await getUserData(req.user.id);

    // Find by imdbID first, then fall back to title param
    const entry = doc.watchlist.find(
      (m) => m.imdbID === imdbID || m._id?.toString() === imdbID
    );
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Movie not found in watchlist.' });
    }

    const watched =
      typeof req.body.watched === 'boolean' ? req.body.watched : !entry.watched;
    entry.watched   = watched;
    entry.watchedAt = watched ? new Date() : null;

    doc.markModified('watchlist');
    await doc.save();

    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[toggleWatched]', err);
    res.status(500).json({ success: false, message: 'Server error updating watched status.' });
  }
};

/**
 * DELETE /api/lists/watchlist/:imdbID
 * Remove a movie from the watchlist by imdbID or MongoDB _id.
 */
exports.removeFromWatchlist = async (req, res) => {
  try {
    const { imdbID } = req.params;
    const doc = await getUserData(req.user.id);

    const before = doc.watchlist.length;
    doc.watchlist = doc.watchlist.filter(
      (m) => m.imdbID !== imdbID && m._id?.toString() !== imdbID
    );

    if (doc.watchlist.length === before) {
      return res.status(404).json({ success: false, message: 'Movie not found in watchlist.' });
    }

    await doc.save();
    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[removeFromWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error removing from watchlist.' });
  }
};

/**
 * PUT /api/lists/watchlist/sync
 * Bulk-sync the entire watchlist from the client (used on login to merge localStorage → DB).
 * Client sends the full array; server merges deduplicating by imdbID/title.
 *
 * Body: { items: [ ...watchlist entries ] }
 */
exports.syncWatchlist = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items must be an array.' });
    }

    const doc = await getUserData(req.user.id);

    // Merge: keep server items, append client items that don't exist on server
    const serverIds = new Set([
      ...doc.watchlist.map((m) => m.imdbID).filter(Boolean),
      ...doc.watchlist.map((m) => m.title),
    ]);

    const incoming = items
      .filter((m) => m && m.title)
      .filter((m) => !serverIds.has(m.imdbID) && !serverIds.has(m.title))
      .map((m) => ({
        imdbID:    trim(m.imdbID, 20),
        title:     trim(m.title, 200),
        poster:    trim(m.poster, 500),
        year:      trim(m.year, 10),
        genre:     trim(m.genre, 100),
        rating:    trim(String(m.rating || ''), 10),
        watched:   !!m.watched,
        addedAt:   m.addedAt ? new Date(m.addedAt) : new Date(),
        watchedAt: m.watchedAt ? new Date(m.watchedAt) : null,
      }));

    doc.watchlist = [...doc.watchlist, ...incoming].slice(0, 500); // cap at 500
    await doc.save();

    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[syncWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error syncing watchlist.' });
  }
};

// ─── READING LIST ─────────────────────────────────────────────────────────────

/**
 * GET /api/lists/reading
 */
exports.getReadingList = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[getReadingList]', err);
    res.status(500).json({ success: false, message: 'Server error fetching reading list.' });
  }
};

/**
 * POST /api/lists/reading
 * Body: { title, author, cover, genre, bookLink, status }
 */
exports.addToReadingList = async (req, res) => {
  try {
    const { title, author, cover, genre, bookLink, status } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required.' });
    }

    const VALID_STATUSES = ['Want to Read', 'Reading', 'Finished'];

    const doc = await getUserData(req.user.id);

    if (doc.readingList.some((b) => b.title === title)) {
      return res.status(409).json({ success: false, message: 'Already in reading list.' });
    }

    const entry = {
      title:           trim(title, 200),
      author:          trim(author, 200),
      cover:           trim(cover, 500),
      genre:           trim(genre, 100),
      bookLink:        trim(bookLink, 500),
      status:          VALID_STATUSES.includes(status) ? status : 'Want to Read',
      addedAt:         new Date(),
      statusUpdatedAt: new Date(),
    };

    doc.readingList.unshift(entry);
    await doc.save();

    res.status(201).json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[addToReadingList]', err);
    res.status(500).json({ success: false, message: 'Server error adding to reading list.' });
  }
};

/**
 * PATCH /api/lists/reading/:bookId/status
 * Update reading status.
 * Body: { status: 'Want to Read' | 'Reading' | 'Finished' }
 */
exports.updateReadingStatus = async (req, res) => {
  try {
    const VALID_STATUSES = ['Want to Read', 'Reading', 'Finished'];
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const { bookId } = req.params;
    const doc = await getUserData(req.user.id);

    const entry = doc.readingList.find(
      (b) => b._id?.toString() === bookId || b.title === bookId
    );
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Book not found in reading list.' });
    }

    entry.status          = status;
    entry.statusUpdatedAt = new Date();

    doc.markModified('readingList');
    await doc.save();

    res.json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[updateReadingStatus]', err);
    res.status(500).json({ success: false, message: 'Server error updating reading status.' });
  }
};

/**
 * DELETE /api/lists/reading/:bookId
 */
exports.removeFromReadingList = async (req, res) => {
  try {
    const { bookId } = req.params;
    const doc = await getUserData(req.user.id);

    const before = doc.readingList.length;
    doc.readingList = doc.readingList.filter(
      (b) => b._id?.toString() !== bookId && b.title !== bookId
    );

    if (doc.readingList.length === before) {
      return res.status(404).json({ success: false, message: 'Book not found in reading list.' });
    }

    await doc.save();
    res.json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[removeFromReadingList]', err);
    res.status(500).json({ success: false, message: 'Server error removing from reading list.' });
  }
};

/**
 * PUT /api/lists/reading/sync
 * Bulk sync reading list from client on login.
 * Body: { items: [ ...readingList entries ] }
 */
exports.syncReadingList = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items must be an array.' });
    }

    const VALID_STATUSES = ['Want to Read', 'Reading', 'Finished'];
    const doc = await getUserData(req.user.id);

    const serverTitles = new Set(doc.readingList.map((b) => b.title));

    const incoming = items
      .filter((b) => b && b.title && !serverTitles.has(b.title))
      .map((b) => ({
        title:           trim(b.title, 200),
        author:          trim(b.author, 200),
        cover:           trim(b.cover, 500),
        genre:           trim(b.genre, 100),
        bookLink:        trim(b.bookLink, 500),
        status:          VALID_STATUSES.includes(b.status) ? b.status : 'Want to Read',
        addedAt:         b.addedAt ? new Date(b.addedAt) : new Date(),
        statusUpdatedAt: b.statusUpdatedAt ? new Date(b.statusUpdatedAt) : new Date(),
      }));

    doc.readingList = [...doc.readingList, ...incoming].slice(0, 500);
    await doc.save();

    res.json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[syncReadingList]', err);
    res.status(500).json({ success: false, message: 'Server error syncing reading list.' });
  }
};

// ─── SONGS HEARD ─────────────────────────────────────────────────────────────

/**
 * GET /api/lists/songs
 */
exports.getSongsHeard = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[getSongsHeard]', err);
    res.status(500).json({ success: false, message: 'Server error fetching songs.' });
  }
};

/**
 * POST /api/lists/songs
 * Body: { trackId, title, artist, album, art, genre, previewUrl }
 */
exports.addSongHeard = async (req, res) => {
  try {
    const { trackId, title, artist, album, art, genre, previewUrl } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required.' });
    }

    const doc = await getUserData(req.user.id);

    // Dedup: same trackId or same title+artist combo played within last 10 minutes
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const isDupe = doc.songsHeard.some(
      (s) =>
        (trackId && s.trackId === String(trackId)) ||
        (s.title === title &&
          s.artist === artist &&
          new Date(s.playedAt).getTime() > tenMinAgo)
    );
    if (isDupe) {
      return res.status(409).json({ success: false, message: 'Song recently logged.' });
    }

    const entry = {
      trackId:    trim(String(trackId || ''), 50),
      title:      trim(title, 200),
      artist:     trim(artist, 200),
      album:      trim(album, 200),
      art:        trim(art, 500),
      genre:      trim(genre, 100),
      previewUrl: trim(previewUrl, 500),
      playedAt:   new Date(),
    };

    doc.songsHeard.unshift(entry);
    doc.songsHeard = doc.songsHeard.slice(0, 200); // rolling cap
    await doc.save();

    res.status(201).json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[addSongHeard]', err);
    res.status(500).json({ success: false, message: 'Server error logging song.' });
  }
};

/**
 * DELETE /api/lists/songs/:songId
 */
exports.removeSongHeard = async (req, res) => {
  try {
    const { songId } = req.params;
    const doc = await getUserData(req.user.id);

    const before = doc.songsHeard.length;
    doc.songsHeard = doc.songsHeard.filter(
      (s) => s._id?.toString() !== songId && s.trackId !== songId
    );

    if (doc.songsHeard.length === before) {
      return res.status(404).json({ success: false, message: 'Song not found.' });
    }

    await doc.save();
    res.json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[removeSongHeard]', err);
    res.status(500).json({ success: false, message: 'Server error removing song.' });
  }
};

/**
 * PUT /api/lists/songs/sync
 * Body: { items: [ ...songsHeard entries ] }
 */
exports.syncSongsHeard = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items must be an array.' });
    }

    const doc = await getUserData(req.user.id);
    const serverIds = new Set(doc.songsHeard.map((s) => s.trackId).filter(Boolean));

    const incoming = items
      .filter((s) => s && s.title)
      .filter((s) => !s.trackId || !serverIds.has(String(s.trackId)))
      .map((s) => ({
        trackId:    trim(String(s.trackId || ''), 50),
        title:      trim(s.title, 200),
        artist:     trim(s.artist, 200),
        album:      trim(s.album, 200),
        art:        trim(s.art, 500),
        genre:      trim(s.genre, 100),
        previewUrl: trim(s.previewUrl, 500),
        playedAt:   s.ts ? new Date(s.ts) : new Date(),
      }));

    doc.songsHeard = [...doc.songsHeard, ...incoming]
      .sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt))
      .slice(0, 200);

    await doc.save();
    res.json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[syncSongsHeard]', err);
    res.status(500).json({ success: false, message: 'Server error syncing songs.' });
  }
};

/**
 * GET /api/lists/all
 * Returns all three lists in a single round-trip — handy for the login sync.
 */
exports.getAllLists = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({
      success: true,
      data: {
        watchlist:   doc.watchlist,
        readingList: doc.readingList,
        songsHeard:  doc.songsHeard,
      },
    });
  } catch (err) {
    console.error('[getAllLists]', err);
    res.status(500).json({ success: false, message: 'Server error fetching all lists.' });
  }
};

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
 * ✅ FIX: changed { user: userId } → { userId } to match the UserData schema
 *         used consistently in recommendController.js
 */
async function getUserData(userId) {
  // ✅ UserData.findOrCreate is defined as a static on the model
  return UserData.findOrCreate(userId);
}

/** Trim a string field — avoids stored XSS noise */
function trim(val, max = 500) {
  return typeof val === 'string' ? val.slice(0, max).trim() : '';
}

// ─── WATCHLIST ───────────────────────────────────────────────────────────────

exports.getWatchlist = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[getWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error fetching watchlist.' });
  }
};

exports.addToWatchlist = async (req, res) => {
  try {
    const { imdbID, title, poster, year, genre, rating } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required.' });
    }

    const doc = await getUserData(req.user.id);

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

exports.toggleWatched = async (req, res) => {
  try {
    const { imdbID } = req.params;
    const doc = await getUserData(req.user.id);

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

exports.syncWatchlist = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items must be an array.' });
    }

    const doc = await getUserData(req.user.id);

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

    doc.watchlist = [...doc.watchlist, ...incoming].slice(0, 500);
    await doc.save();

    res.json({ success: true, data: doc.watchlist });
  } catch (err) {
    console.error('[syncWatchlist]', err);
    res.status(500).json({ success: false, message: 'Server error syncing watchlist.' });
  }
};

// ─── READING LIST ─────────────────────────────────────────────────────────────

exports.getReadingList = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.readingList });
  } catch (err) {
    console.error('[getReadingList]', err);
    res.status(500).json({ success: false, message: 'Server error fetching reading list.' });
  }
};

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

exports.getSongsHeard = async (req, res) => {
  try {
    const doc = await getUserData(req.user.id);
    res.json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[getSongsHeard]', err);
    res.status(500).json({ success: false, message: 'Server error fetching songs.' });
  }
};

exports.addSongHeard = async (req, res) => {
  try {
    const { trackId, title, artist, album, art, genre, previewUrl } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'title is required.' });
    }

    const doc = await getUserData(req.user.id);

    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const isDupe = doc.songsHeard.some(
      (s) =>
        (trackId && s.trackId === String(trackId)) ||
        (s.title === title &&
          s.artist === artist &&
          new Date(s.heardAt).getTime() > tenMinAgo)  // ✅ matches schema
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
      heardAt:    new Date(),   // ✅ matches SongHeardSchema field name
    };

    doc.songsHeard.unshift(entry);
    doc.songsHeard = doc.songsHeard.slice(0, 200);
    await doc.save();

    res.status(201).json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[addSongHeard]', err);
    res.status(500).json({ success: false, message: 'Server error logging song.' });
  }
};

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
        heardAt:    s.ts ? new Date(s.ts) : new Date(),  // ✅ matches schema
      }));

    doc.songsHeard = [...doc.songsHeard, ...incoming]
      .sort((a, b) => new Date(b.heardAt) - new Date(a.heardAt))  // ✅ sort by heardAt
      .slice(0, 200);

    await doc.save();
    res.json({ success: true, data: doc.songsHeard });
  } catch (err) {
    console.error('[syncSongsHeard]', err);
    res.status(500).json({ success: false, message: 'Server error syncing songs.' });
  }
};

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

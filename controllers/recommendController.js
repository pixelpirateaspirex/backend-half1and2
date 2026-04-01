'use strict';

const axios    = require('axios');
const UserData = require('../models/UserData');

const PYTHON_URL = (process.env.PYTHON_SERVICE_URL || 'http://localhost:5001').replace(/\/$/, '');
const OMDB_KEY   = process.env.OMDB_API_KEY || '';

// ════════════════════════════════════════════════════════════════════════════
//  FIX 1: In-memory recommendation cache
//  Key: `${userId}:${type}` → { data, expiresAt }
//  TTL: 10 minutes — prevents hammering Python on every tab switch.
//  Python cold-start on Render free tier can take 30-60s; without this
//  cache every tab switch triggers a new cold start timeout chain.
// ════════════════════════════════════════════════════════════════════════════
const REC_CACHE     = new Map();
const REC_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedRec(userId, type) {
  const key    = `${userId}:${type}`;
  const entry  = REC_CACHE.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  REC_CACHE.delete(key);
  return null;
}

function setCachedRec(userId, type, data) {
  REC_CACHE.set(`${userId}:${type}`, {
    data,
    expiresAt: Date.now() + REC_CACHE_TTL,
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  FIX 2: In-memory OMDB cache
//  Key: movie title → enriched movie object
//  TTL: 60 minutes.
//  Without this, fetching 20 movies makes 20 OMDB API calls per request.
//  OMDB free tier = 1000 req/day → exhausted within 50 movie page loads.
//  With this cache, repeated titles (across users / refreshes) cost 0 calls.
// ════════════════════════════════════════════════════════════════════════════
const OMDB_CACHE     = new Map();
const OMDB_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

function getCachedOMDB(title) {
  const entry = OMDB_CACHE.get(title.toLowerCase());
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  OMDB_CACHE.delete(title.toLowerCase());
  return null;
}

function setCachedOMDB(title, data) {
  OMDB_CACHE.set(title.toLowerCase(), {
    data,
    expiresAt: Date.now() + OMDB_CACHE_TTL,
  });
}

// Periodically purge expired entries so the Maps don't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of REC_CACHE)  if (v.expiresAt <= now) REC_CACHE.delete(k);
  for (const [k, v] of OMDB_CACHE) if (v.expiresAt <= now) OMDB_CACHE.delete(k);
}, 15 * 60 * 1000);


// ════════════════════════════════════════════════════════════════════════════
//  GET /api/preferences  (protected)
// ════════════════════════════════════════════════════════════════════════════
exports.getPreferences = async (req, res) => {
  try {
    const userData = await UserData.findOne({ userId: req.user.id });
    if (!userData) {
      return res.status(404).json({ success: false, message: 'No preferences found.' });
    }
    res.json({
      success: true,
      preferences: {
        movieGenres:       userData.movieGenres       || [],
        musicGenres:       userData.musicGenres       || [],
        gameGenres:        userData.gameGenres        || [],
        audiobookDuration: userData.audiobookDuration || [],
        audiobookPrice:    userData.audiobookPrice    || [],
        language:          userData.language          || [],
        contentTypes:      userData.contentTypes      || [],
        onboarded:         userData.onboarded         || false,
      },
    });
  } catch (err) {
    console.error('getPreferences error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/preferences  (protected)
// ════════════════════════════════════════════════════════════════════════════
exports.savePreferences = async (req, res) => {
  try {
    const {
      movieGenres, musicGenres, gameGenres,
      audiobookDuration, audiobookPrice, language, contentTypes,
    } = req.body;

    if (!contentTypes || !contentTypes.length) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one content type.',
      });
    }

    // FIX: Invalidate cached recommendations when user updates preferences,
    // otherwise they'll keep seeing stale results for up to 10 minutes.
    for (const type of ['movies', 'songs', 'games', 'audiobooks']) {
      REC_CACHE.delete(`${req.user.id}:${type}`);
    }

    const userData = await UserData.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          movieGenres:       movieGenres       || [],
          musicGenres:       musicGenres       || [],
          gameGenres:        gameGenres        || [],
          audiobookDuration: audiobookDuration || [],
          audiobookPrice:    audiobookPrice    || [],
          language:          language          || ['English'],
          contentTypes,
          onboarded: true,
        },
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, preferences: userData });
  } catch (err) {
    console.error('savePreferences error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  Helper – enrich a single movie with OMDB poster + metadata (cached)
// ════════════════════════════════════════════════════════════════════════════
async function enrichMovieWithOMDB(movie) {
  if (!OMDB_KEY) return movie;
  const title = movie.title || movie.Title || '';
  if (!title) return movie;

  // Return cached result immediately — no API call
  const cached = getCachedOMDB(title);
  if (cached) return cached;

  try {
    const { data } = await axios.get('https://www.omdbapi.com/', {
      params: { t: title, apikey: OMDB_KEY, type: 'movie' },
      timeout: 5_000,
    });

    let enriched = movie;
    if (data.Response === 'True') {
      enriched = {
        ...movie,
        Poster:     data.Poster     !== 'N/A' ? data.Poster : undefined,
        imdbID:     data.imdbID     || movie.imdbID,
        Year:       data.Year       || movie.Year,
        imdbRating: data.imdbRating || movie.imdbRating,
        Genre:      data.Genre      || movie.Genre,
      };
    }

    // Cache whether found or not — avoids retrying failed titles every time
    setCachedOMDB(title, enriched);
    return enriched;

  } catch (err) {
    // FIX: On OMDB 429 specifically, cache the original movie (no poster)
    // so we stop calling OMDB for this title until cache expires.
    if (err.response?.status === 429) {
      console.warn(`[OMDB] Rate limited on title="${title}" — caching stub for 60 min`);
      setCachedOMDB(title, movie);
    }
    // OMDB timeout / error — return original movie without caching
    return movie;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  FIX 3: Helper – call Python service with one automatic retry on 503
//  Render free-tier Python service sleeps after 15 min inactivity.
//  First request wakes it (takes 30-60 s) and may return 503 or time out.
//  Retrying once after a short delay handles the "waking up" window.
// ════════════════════════════════════════════════════════════════════════════
async function callPython(type, payload, retries = 1) {
  try {
    return await axios.post(
      `${PYTHON_URL}/recommend/${type}`,
      payload,
      { timeout: 60_000 } // 60s — enough for a cold-start model download
    );
  } catch (err) {
    const status = err.response?.status;
    // Retry on 503 (service unavailable / waking up) or timeout
    if (retries > 0 && (status === 503 || err.code === 'ECONNABORTED')) {
      console.log(`[recommend] Python returned ${status || 'timeout'} — retrying in 5s…`);
      await new Promise(r => setTimeout(r, 5_000));
      return callPython(type, payload, retries - 1);
    }
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  GET /api/recommend/:type  (protected)
//  :type = movies | songs | games | audiobooks
// ════════════════════════════════════════════════════════════════════════════
exports.getRecommendations = async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['movies', 'songs', 'games', 'audiobooks'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: `Invalid type. Accepted: ${validTypes.join(', ')}`,
      });
    }

    // ── FIX 1: Serve from cache if available ─────────────────────────────
    const cachedResult = getCachedRec(req.user.id, type);
    if (cachedResult) {
      console.log(`[recommend] Cache HIT for user=${req.user.id} type=${type}`);
      return res.json(cachedResult);
    }

    // ── Load saved preferences ────────────────────────────────────────────
    const userData = await UserData.findOne({ userId: req.user.id });
    if (!userData || !userData.onboarded) {
      return res.status(400).json({
        success: false,
        message: 'Please complete onboarding to get recommendations.',
        needsOnboarding: true,
      });
    }

    // ── Build payload for Python service ──────────────────────────────────
    let payload = { n: 20 };

    if (type === 'audiobooks') {
      payload.filters = {
        duration:   userData.audiobookDuration || [],
        price_tier: userData.audiobookPrice    || [],
        language:   userData.language.length   ? userData.language : ['English'],
      };
    } else {
      const genreMap = {
        movies: userData.movieGenres || [],
        songs:  userData.musicGenres || [],
        games:  userData.gameGenres  || [],
      };
      payload.genres = genreMap[type] || [];
      if (!payload.genres.length) {
        const emptyResult = { recommendations: [] };
        setCachedRec(req.user.id, type, emptyResult);
        return res.json(emptyResult);
      }
    }

    // ── Call Python service (with retry) ──────────────────────────────────
    const { data } = await callPython(type, payload);

    // ── Enrich movies with OMDB posters (parallel, cached) ────────────────
    if (type === 'movies' && Array.isArray(data.recommendations)) {
      data.recommendations = await Promise.all(
        data.recommendations.map((movie) => enrichMovieWithOMDB(movie))
      );
    }

    // ── Store in cache before responding ──────────────────────────────────
    setCachedRec(req.user.id, type, data);

    res.json(data);

  } catch (err) {

    // ── Python service not running / wrong PYTHON_SERVICE_URL env var ─────
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      console.error(`[recommend] Python service unreachable at ${PYTHON_URL}. Check PYTHON_SERVICE_URL env var.`);
      return res.status(503).json({
        success: false,
        message: 'Recommendation service is temporarily unavailable. Please try again later.',
      });
    }

    // ── Python service timed out even after retry ─────────────────────────
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error(`[recommend] Python service timed out at ${PYTHON_URL} after retry.`);
      return res.status(503).json({
        success: false,
        message: 'Recommendation service is still waking up. Please retry in 30 seconds.',
        retryAfter: 30,
      });
    }

    // ── Python service returned a non-2xx HTTP error ──────────────────────
    if (err.response) {
      console.error(`[recommend] Python service returned ${err.response.status}:`, err.response.data);
      return res.status(err.response.status).json({
        success: false,
        message: err.response.data?.error || err.response.data?.message || 'Recommendation service error.',
      });
    }

    // ── Unexpected error ──────────────────────────────────────────────────
    console.error('getRecommendations error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

'use strict';

const axios    = require('axios');
const UserData = require('../models/UserData');

const PYTHON_URL = (process.env.PYTHON_SERVICE_URL || 'http://localhost:5001').replace(/\/$/, '');
const OMDB_KEY   = process.env.OMDB_API_KEY || '';

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
//  Helper – enrich a single movie with OMDB poster + metadata
// ════════════════════════════════════════════════════════════════════════════
async function enrichMovieWithOMDB(movie) {
  if (!OMDB_KEY) return movie;
  const title = movie.title || movie.Title || '';
  if (!title) return movie;

  try {
    const { data } = await axios.get('https://www.omdbapi.com/', {
      params: { t: title, apikey: OMDB_KEY, type: 'movie' },
      timeout: 5_000,
    });

    if (data.Response === 'True') {
      return {
        ...movie,
        Poster:     data.Poster     !== 'N/A' ? data.Poster : undefined,
        imdbID:     data.imdbID     || movie.imdbID,
        Year:       data.Year       || movie.Year,
        imdbRating: data.imdbRating || movie.imdbRating,
        Genre:      data.Genre      || movie.Genre,
      };
    }
  } catch {
    // OMDB timeout / error – return original movie
  }
  return movie;
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
        return res.json({ recommendations: [] });
      }
    }

    // ── Call Python service ───────────────────────────────────────────────
    // FIX: Increased timeout to 30s — Python service downloads models from
    // Google Drive on cold start which can easily exceed 15s on free tier.
    const { data } = await axios.post(
      `${PYTHON_URL}/recommend/${type}`,
      payload,
      { timeout: 30_000 }
    );

    // ── Enrich movies with OMDB posters (parallel) ────────────────────────
    if (type === 'movies' && Array.isArray(data.recommendations)) {
      data.recommendations = await Promise.all(
        data.recommendations.map((movie) => enrichMovieWithOMDB(movie))
      );
    }

    res.json(data);

  } catch (err) {

    // ── FIX: Python service not running / wrong PYTHON_SERVICE_URL env var ─
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      console.error(`[recommend] Python service unreachable at ${PYTHON_URL}. Set PYTHON_SERVICE_URL env var.`);
      return res.status(503).json({
        success: false,
        message: 'Recommendation service is temporarily unavailable. Please try again later.',
      });
    }

    // ── FIX: Python service timed out (cold start / model download too slow) ─
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      console.error(`[recommend] Python service timed out at ${PYTHON_URL}. Cold start may still be in progress.`);
      return res.status(503).json({
        success: false,
        message: 'Recommendation service is waking up. Please retry in 30 seconds.',
      });
    }

    // ── FIX: Python service returned a non-2xx HTTP error (e.g. its own 503) ─
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

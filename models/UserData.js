'use strict';

const mongoose = require('mongoose');

// ════════════════════════════════════════════════════════════════════════════
//  SUB-SCHEMAS  (embedded documents inside UserData)
// ════════════════════════════════════════════════════════════════════════════

const WatchlistItemSchema = new mongoose.Schema(
  {
    imdbID:    { type: String, default: '' },
    title:     { type: String, required: true, trim: true },
    poster:    { type: String, default: '' },
    year:      { type: String, default: '' },
    genre:     { type: String, default: '' },
    rating:    { type: String, default: '' },
    watched:   { type: Boolean, default: false },
    watchedAt: { type: Date,    default: null },
    addedAt:   { type: Date,    default: Date.now },
  },
  { _id: true }
);

const ReadingListItemSchema = new mongoose.Schema(
  {
    googleBookId:    { type: String, default: '' },
    title:           { type: String, required: true, trim: true },
    author:          { type: String, default: 'Unknown' },
    cover:           { type: String, default: '' },
    genre:           { type: String, default: '' },
    bookLink:        { type: String, default: '' },
    status: {
      type:    String,
      enum:    ['Want to Read', 'Reading', 'Finished'],
      default: 'Want to Read',
    },
    addedAt:         { type: Date, default: Date.now },
    statusUpdatedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const SongHeardSchema = new mongoose.Schema(
  {
    trackId:    { type: String, default: '' },
    title:      { type: String, required: true, trim: true },
    artist:     { type: String, default: '' },
    album:      { type: String, default: '' },
    art:        { type: String, default: '' },
    genre:      { type: String, default: '' },
    previewUrl: { type: String, default: '' },
    heardAt:    { type: Date,   default: Date.now },
  },
  { _id: true }
);

const ActivityItemSchema = new mongoose.Schema(
  {
    type:  { type: String, enum: ['movie', 'book', 'song'], required: true },
    title: { type: String, required: true },
    genre: { type: String, default: '' },
    ts:    { type: Date,   default: Date.now },
  },
  { _id: false }
);

const RecentlyViewedSchema = new mongoose.Schema(
  {
    type:   { type: String, enum: ['movie', 'book'] },
    title:  { type: String },
    poster: { type: String, default: '' },
    id:     { type: String },
    ts:     { type: Date,   default: Date.now },
  },
  { _id: false }
);

const QuizAttemptSchema = new mongoose.Schema(
  {
    score:     { type: Number,  required: true },
    total:     { type: Number,  required: true },
    earned:    { type: Number,  default: 0 },
    badge:     { type: String,  default: '🥉 Bronze' },
    isPerfect: { type: Boolean, default: false },
    isFirst:   { type: Boolean, default: false },
    ts:        { type: Date,    default: Date.now },
  },
  { _id: false }
);

const ChatMessageSchema = new mongoose.Schema(
  {
    role:    { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    time:    { type: String, default: '' },
    ts:      { type: Date,   default: Date.now },
  },
  { _id: false }
);

// ════════════════════════════════════════════════════════════════════════════
//  MAIN USER DATA SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const UserDataSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // ── AI Recommendation Preferences (set during onboarding) ────────────────
  movieGenres:       { type: [String], default: [] },  // ['Action', 'Drama']
  musicGenres:       { type: [String], default: [] },  // ['Pop', 'Rock']
  gameGenres:        { type: [String], default: [] },  // ['RPG', 'Strategy']
  audiobookDuration: { type: [String], default: [] },  // ['short', 'medium']
  audiobookPrice:    { type: [String], default: [] },  // ['free_low', 'budget']
  language:          { type: [String], default: ['English'] },
  contentTypes:      { type: [String], default: [] },  // ['movies', 'songs', ...]

  // ── Onboarding state ──────────────────────────────────────────────────────
  onboarded: { type: Boolean, default: false },

  // ── Premium mirror (denormalised for fast reads) ───────────────────────────
  isPremium: { type: Boolean, default: false },

  // ── Lists ─────────────────────────────────────────────────────────────────
  watchlist:    { type: [WatchlistItemSchema],    default: [] },
  readingList:  { type: [ReadingListItemSchema],  default: [] },
  songsHeard:   { type: [SongHeardSchema],        default: [] },

  // ── Activity / analytics ──────────────────────────────────────────────────
  userHistory:    { type: [ActivityItemSchema],    default: [] },
  recentlyViewed: { type: [RecentlyViewedSchema],  default: [] },

  // ── Quiz history ──────────────────────────────────────────────────────────
  quizAttempts: { type: [QuizAttemptSchema], default: [] },

  // ── Chatbot history ───────────────────────────────────────────────────────
  chatHistory: { type: [ChatMessageSchema], default: [] },
});

// ── Index ─────────────────────────────────────────────────────────────────────
UserDataSchema.index({ userId: 1 }, { unique: true });

// ════════════════════════════════════════════════════════════════════════════
//  STATIC METHODS
// ════════════════════════════════════════════════════════════════════════════
UserDataSchema.statics.findOrCreate = async function (userId) {
  let doc = await this.findOne({ userId });
  if (!doc) {
    doc = await this.create({ userId });
  }
  return doc;
};

// ════════════════════════════════════════════════════════════════════════════
//  INSTANCE HELPERS
// ════════════════════════════════════════════════════════════════════════════
UserDataSchema.methods.trackActivity = function (type, title, genre) {
  this.userHistory.unshift({ type, title, genre, ts: new Date() });
  if (this.userHistory.length > 50) this.userHistory = this.userHistory.slice(0, 50);
};

UserDataSchema.methods.addRecentlyViewed = function (type, title, poster, id) {
  this.recentlyViewed = [
    { type, title, poster, id, ts: new Date() },
    ...this.recentlyViewed.filter((r) => r.id !== id),
  ].slice(0, 30);
};

UserDataSchema.methods.pushChatMessage = function (role, content, time) {
  this.chatHistory.push({ role, content, time, ts: new Date() });
  if (this.chatHistory.length > 60) this.chatHistory = this.chatHistory.slice(-60);
};

// ════════════════════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════════════════════
module.exports = mongoose.model('UserData', UserDataSchema);

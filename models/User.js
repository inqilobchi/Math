const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, default: 'O\'yinchi' },
  avatar: { type: String, default: '🦊' },
  rank: { type: String, default: 'bronze' },
  totalScore: { type: Number, default: 0 },
  gamesPlayed: { type: Number, default: 0 },
  correct: { type: Number, default: 0 },
  wrong: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  lastDate: { type: Date },
  lives: { type: Number, default: 3 },
  extraTime: { type: Number, default: 0 },
  referrals: [{ type: String }],
  refEarnings: { type: Number, default: 0 },
  tasks: {
    refs: { type: Number, default: 0 },
    games: { type: Number, default: 0 },
    bought: { type: Boolean, default: false }
  },
  isPremium: { type: Boolean, default: false },
  pendingRequest: { type: String },
  isAdmin: { type: Boolean, default: false },
  joinDate: { type: Date, default: Date.now },
  instagramBonus: { type: Boolean, default: false }  
});

module.exports = mongoose.model('User', userSchema);

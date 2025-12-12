const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  userName: { type: String },
  userAvatar: { type: String },
  userRank: { type: String },
  type: { type: String, required: true }, // 'premium' or 'rank'
  amount: { type: String },
  product: { type: String },
  screenshot: { type: String }, // Base64 yoki fayl path
  targetRank: { type: String },
  status: { type: String, default: 'pending' }, // 'pending', 'approved', 'rejected'
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Payment', paymentSchema);
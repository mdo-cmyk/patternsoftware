const mongoose = require('mongoose');

const patternMasterSchema = new mongoose.Schema({
  patternNumber: { type: String, required: true, trim: true, unique: true, index: true },
  patternName: { type: String, required: true, trim: true },
  patternImagePath: { type: String, default: null },
  assignedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedUsername: { type: String, trim: true, default: null },
  isDiscarded: { type: Boolean, default: false, index: true },
  discardedAt: { type: Date, default: null },
  discardedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('PatternMaster', patternMasterSchema);

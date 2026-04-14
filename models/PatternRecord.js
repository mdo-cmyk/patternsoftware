const mongoose = require('mongoose');

const patternRecordSchema = new mongoose.Schema({
  patternNumber: { type: String, required: true, trim: true, index: true },
  patternName: { type: String, required: true, trim: true },
  type: { type: String, enum: ['handover', 'receive'], required: true },
  handoverTo: { type: String, trim: true, default: null },
  receiveFrom: { type: String, trim: true, default: null },
  recordDate: { type: Date, required: true },
  photoPath: { type: String, default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

patternRecordSchema.index({ patternNumber: 1, createdAt: -1 });

module.exports = mongoose.model('PatternRecord', patternRecordSchema);

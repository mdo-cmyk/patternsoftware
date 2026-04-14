const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const PatternRecord = require('../models/PatternRecord');
const { requireAuth } = require('../middleware/auth');
const {
  DEFAULT_PARTY_NAMES,
  HANDOVER_TO_DEFAULT,
  RECEIVE_FROM_DEFAULT
} = require('../config/defaultUsers');
const {
  canUsePatternRecord,
  getVisiblePatternRecordQuery
} = require('../utils/patternRecordVisibility');

const router = express.Router();
const uploadDirectory = path.join(__dirname, '..', 'public', 'uploads');

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDirectory);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

function ensureStandardUser(req, res, next) {
  if (req.session.role === 'admin') {
    return res.redirect('/users');
  }

  return next();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getPatternNumbers() {
  const patternNumbers = await PatternRecord.distinct('patternNumber');

  return patternNumbers
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function getSupervisorNames() {
  return DEFAULT_PARTY_NAMES;
}

function removeUploadedFile(filename) {
  if (!filename) {
    return Promise.resolve();
  }

  const filePath = path.join(uploadDirectory, filename);
  return fs.promises.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') {
      console.error(error);
    }
  });
}

function formatDateForInput(value = new Date()) {
  return new Date(value).toISOString().split('T')[0];
}

async function renderPatternForm(req, res, options = {}) {
  const {
    type,
    status = 200,
    error = null,
    formData = {}
  } = options;

  const patternNumbers = await getPatternNumbers();
  const supervisorNames = await getSupervisorNames();

  return res.status(status).render('patternForm', {
    type,
    error,
    patternNumbers,
    supervisorNames,
    formData: {
      patternNumber: formData.patternNumber || '',
      patternName: formData.patternName || '',
      handoverTo: formData.handoverTo || HANDOVER_TO_DEFAULT,
      receiveFrom: formData.receiveFrom || RECEIVE_FROM_DEFAULT,
      recordDate: formData.recordDate || formatDateForInput()
    }
  });
}

async function findPatternByNumber(patternNumber) {
  if (!patternNumber) {
    return null;
  }

  return PatternRecord.findOne({
    patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' }
  }).sort({ createdAt: -1 });
}

router.get('/search', requireAuth, async (req, res) => {
  const patternNumber = (req.query.patternNumber || '').trim();

  if (!patternNumber) {
    return res.json({ found: false, patternName: '' });
  }

  const record = await findPatternByNumber(patternNumber);

  return res.json({
    found: Boolean(record),
    patternName: record ? record.patternName : ''
  });
});

router.get('/handover', requireAuth, ensureStandardUser, async (req, res) => {
  return renderPatternForm(req, res, { type: 'handover' });
});

router.post('/handover', requireAuth, ensureStandardUser, upload.single('photo'), async (req, res) => {
  const patternNumber = (req.body.patternNumber || '').trim();
  const handoverTo = (req.body.handoverTo || '').trim();
  const recordDate = req.body.recordDate || '';
  const existingPattern = await findPatternByNumber(patternNumber);
  const patternName = ((req.body.patternName || '').trim() || existingPattern?.patternName || '').trim();

  if (!patternNumber || !patternName || !handoverTo || !recordDate) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    return renderPatternForm(req, res, {
      type: 'handover',
      status: 400,
      error: 'Pattern number, pattern name, handover to, and date are required.',
      formData: { patternNumber, patternName, handoverTo, recordDate }
    });
  }

  await PatternRecord.create({
    patternNumber,
    patternName,
    type: 'handover',
    handoverTo,
    recordDate,
    photoPath: req.file ? req.file.filename : null,
    userId: req.session.userId
  });

  return res.redirect('/patterns/dashboard');
});

router.get('/receive', requireAuth, ensureStandardUser, async (req, res) => {
  return renderPatternForm(req, res, { type: 'receive' });
});

router.post('/receive', requireAuth, ensureStandardUser, upload.single('photo'), async (req, res) => {
  const patternNumber = (req.body.patternNumber || '').trim();
  const receiveFrom = (req.body.receiveFrom || '').trim();
  const recordDate = req.body.recordDate || '';
  const existingPattern = await findPatternByNumber(patternNumber);
  const patternName = ((req.body.patternName || '').trim() || existingPattern?.patternName || '').trim();

  if (!patternNumber || !patternName || !receiveFrom || !recordDate) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    return renderPatternForm(req, res, {
      type: 'receive',
      status: 400,
      error: 'Pattern number, pattern name, receive from, and date are required.',
      formData: { patternNumber, patternName, receiveFrom, recordDate }
    });
  }

  await PatternRecord.create({
    patternNumber,
    patternName,
    type: 'receive',
    receiveFrom,
    recordDate,
    photoPath: req.file ? req.file.filename : null,
    userId: req.session.userId
  });

  return res.redirect('/patterns/dashboard');
});

router.post('/delete/:id', requireAuth, async (req, res) => {
  const record = await PatternRecord.findById(req.params.id);

  if (!record) {
    return res.status(404).render('error', {
      title: 'Pattern record not found',
      message: 'The selected pattern record could not be found.'
    });
  }

  const isAdmin = req.session.role === 'admin';
  const canUseRecord = await canUsePatternRecord(req, record);

  if (!canUseRecord) {
    return res.status(403).render('error', {
      title: 'Access denied',
      message: 'You do not have permission to remove this pattern record.'
    });
  }

  await removeUploadedFile(record.photoPath);
  await PatternRecord.findByIdAndDelete(req.params.id);

  if (isAdmin) {
    return res.redirect('/users');
  }

  return res.redirect('/patterns/dashboard');
});

router.get('/dashboard', requireAuth, async (req, res) => {
  if (req.session.role === 'admin') {
    return res.redirect('/users');
  }

  const query = await getVisiblePatternRecordQuery(req);
  const records = await PatternRecord.find(query).sort({ recordDate: -1, createdAt: -1 });

  return res.render('userDashboard', { records });
});

module.exports = router;

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PatternRecord = require('../models/PatternRecord');
const PatternMaster = require('../models/PatternMaster');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { isValidId } = require('../db/modelHelpers');
const { requireAuth } = require('../middleware/auth');
const { DEFAULT_PARTY_NAMES } = require('../config/defaultUsers');
const {
  canUsePatternRecord,
  getVisiblePatternRecordQuery
} = require('../utils/patternRecordVisibility');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchFilter(search) {
  const value = String(search || '').trim();
  if (!value) {
    return null;
  }
  const regex = { $regex: escapeRegExp(value), $options: 'i' };
  return { $or: [{ patternNumber: regex }, { patternName: regex }] };
}

function buildPatternNumberFilter(patternNumber) {
  const value = String(patternNumber || '').trim();
  if (!value) {
    return null;
  }
  return { patternNumber: { $regex: escapeRegExp(value), $options: 'i' } };
}

function mergeQuery(baseQuery, ...filters) {
  const cleanFilters = filters.filter(Boolean);
  if (!baseQuery || Object.keys(baseQuery).length === 0) {
    if (cleanFilters.length === 0) return {};
    if (cleanFilters.length === 1) return cleanFilters[0];
    return { $and: cleanFilters };
  }
  if (cleanFilters.length === 0) {
    return baseQuery;
  }
  return { $and: [baseQuery, ...cleanFilters] };
}

async function findPatternByNumber(patternNumber) {
  if (!patternNumber) {
    return null;
  }

  const master = await PatternMaster.findOne({
    patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' },
    isDiscarded: { $ne: true }
  });

  if (master) {
    return { patternNumber: master.patternNumber, patternName: master.patternName };
  }

  const record = await PatternRecord.findOne({
    patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' }
  }).sort({ createdAt: -1 });

  return record;
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

// API Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  
  if (user && await bcrypt.compare(password, user.password)) {
    req.session.userId = user._id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.allowedPages = Array.isArray(user.allowedPages) ? user.allowedPages : null;
    return res.json({ username: user.username, role: user.role, allowedPages: req.session.allowedPages });
  } else {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
});

// API Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get Dashboard Data
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const query = await getVisiblePatternRecordQuery(req);
    
    const records = await PatternRecord.find(query).sort({ recordDate: -1, createdAt: -1 }).limit(10);
    const totalRecords = await PatternRecord.countDocuments(query);
    const handovers = await PatternRecord.countDocuments({ ...query, type: 'handover' });
    const receives = await PatternRecord.countDocuments({ ...query, type: 'receive' });
    const photos = records.filter(r => r.photoPath).length;
    
    res.json({
      totalRecords,
      handovers,
      receives,
      photos,
      records
    });
  } catch (error) {
    res.status(500).json({ error: 'Error loading dashboard' });
  }
});

// Get Pattern Numbers
router.get('/pattern-numbers', requireAuth, async (req, res) => {
  try {
    const masterNumbers = await PatternMaster.distinct('patternNumber', { isDiscarded: { $ne: true } });
    const recordNumbers = await PatternRecord.distinct('patternNumber');
    const numbers = Array.from(new Set([...masterNumbers, ...recordNumbers]));
    const sorted = numbers.filter(Boolean).sort((a, b) => a.localeCompare(b));
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: 'Error loading pattern numbers' });
  }
});

// Admin: active master pattern numbers (for discard selection)
router.get('/master-pattern-numbers', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const numbers = await PatternMaster.distinct('patternNumber', { isDiscarded: { $ne: true } });
    const sorted = numbers.filter(Boolean).sort((a, b) => a.localeCompare(b));
    return res.json(sorted);
  } catch (error) {
    return res.status(500).json({ error: 'Error loading master pattern numbers' });
  }
});

// Pattern numbers that already have activity records
router.get('/activity-pattern-numbers', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const numbers = await PatternRecord.distinct('patternNumber', { patternNumber: { $ne: null, $ne: '' } });
    const sorted = numbers.filter(Boolean).sort((a, b) => a.localeCompare(b));
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ error: 'Error loading activity pattern numbers' });
  }
});

// Search Pattern
router.get('/search-pattern', requireAuth, async (req, res) => {
  const patternNumber = (req.query.patternNumber || '').trim();
  
  if (!patternNumber) {
    return res.json({ found: false, patternName: '' });
  }
  
  const record = await findPatternByNumber(patternNumber);
  res.json({
    found: Boolean(record),
    patternName: record ? record.patternName : ''
  });
});

// Save Handover
router.post('/handover', requireAuth, upload.single('photo'), async (req, res) => {
  const patternNumber = (req.body.patternNumber || '').trim();
  const handoverTo = (req.body.handoverTo || '').trim();
  const recordDate = req.body.recordDate || '';
  const existingPattern = await findPatternByNumber(patternNumber);
  const patternName = ((req.body.patternName || '').trim() || existingPattern?.patternName || '').trim();
  
  if (!patternNumber || !patternName || !handoverTo || !recordDate) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  try {
    await PatternRecord.create({
      patternNumber,
      patternName,
      type: 'handover',
      handoverTo,
      recordDate,
      photoPath: req.file ? req.file.filename : null,
      userId: req.session.userId
    });
    res.json({ success: true });
  } catch (error) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    res.status(500).json({ error: 'Error saving record' });
  }
});

// Save Receive
router.post('/receive', requireAuth, upload.single('photo'), async (req, res) => {
  const patternNumber = (req.body.patternNumber || '').trim();
  const receiveFrom = (req.body.receiveFrom || '').trim();
  const recordDate = req.body.recordDate || '';
  const existingPattern = await findPatternByNumber(patternNumber);
  const patternName = ((req.body.patternName || '').trim() || existingPattern?.patternName || '').trim();
  
  if (!patternNumber || !patternName || !receiveFrom || !recordDate) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  try {
    await PatternRecord.create({
      patternNumber,
      patternName,
      type: 'receive',
      receiveFrom,
      recordDate,
      photoPath: req.file ? req.file.filename : null,
      userId: req.session.userId
    });
    res.json({ success: true });
  } catch (error) {
    await removeUploadedFile(req.file ? req.file.filename : null);
    res.status(500).json({ error: 'Error saving record' });
  }
});

// Delete Record
router.post('/delete/:id', requireAuth, async (req, res) => {
  try {
    const record = await PatternRecord.findById(req.params.id);
    
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }
    
    if (!await canUsePatternRecord(req, record)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await removeUploadedFile(record.photoPath);
    await PatternRecord.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting record' });
  }
});

// Admin: Add User
router.post('/add-user', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const role = 'user';
  const allowedPages = Array.isArray(req.body.allowedPages) ? req.body.allowedPages : [];
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const validPages = new Set(['dashboard', 'handover', 'receive', 'users', 'patterns', 'discardPatterns', 'viewPatterns', 'activity']);
  const normalizedAllowedPages = allowedPages
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => validPages.has(value));
  const uniqueAllowedPages = Array.from(new Set(normalizedAllowedPages));

  if (uniqueAllowedPages.length === 0) {
    return res.status(400).json({ error: 'Please select at least one page permission.' });
  }
  
  try {
    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword, role, allowedPages: uniqueAllowedPages });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

// Get list of users for handover/receive selection
router.get('/users', requireAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('_id username').sort({ username: 1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Error loading users' });
  }
});

// Admin: Get Users List
router.get('/users-list', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const users = await User.find({}).select('_id username role allowedPages').sort({ username: 1 });
    const usersWithCounts = await Promise.all(users.map(async (user) => {
      const recordCount = await PatternRecord.countDocuments({ userId: user._id });
      return {
        _id: user._id,
        username: user.username,
        role: user.role,
        allowedPages: Array.isArray(user.allowedPages) ? user.allowedPages : null,
        recordCount
      };
    }));
    res.json(usersWithCounts);
  } catch (error) {
    res.status(500).json({ error: 'Error loading users' });
  }
});

// Admin: Delete User
router.post('/delete-user/:id', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  try {
    const userRecords = await PatternRecord.find({ userId: req.params.id }).select('photoPath');
    
    await Promise.all(userRecords.map(async (record) => {
      if (record.photoPath) {
        const filePath = path.join(uploadDirectory, record.photoPath);
        try {
          await fs.promises.unlink(filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.error(error);
          }
        }
      }
    }));
    
    await User.findByIdAndDelete(req.params.id);
    await PatternRecord.deleteMany({ userId: req.params.id });
    await PatternMaster.updateMany(
      { assignedUserId: req.params.id },
      { $set: { assignedUserId: null, assignedUsername: null } }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting user' });
  }
});

// Admin: Add Pattern Master
router.post('/add-pattern', requireAuth, upload.single('patternImage'), async (req, res) => {
  if (req.session.role !== 'admin') {
    await removeUploadedFile(req.file ? req.file.filename : null);
    return res.status(403).json({ error: 'Admin only' });
  }

  const patternNumber = (req.body.patternNumber || '').trim();
  const patternName = (req.body.patternName || '').trim();
  const patternImagePath = req.file ? req.file.filename : null;

  if (!patternNumber || !patternName) {
    await removeUploadedFile(patternImagePath);
    return res.status(400).json({ error: 'Pattern number and pattern name are required' });
  }

  try {
    const existing = await PatternMaster.findOne({
      patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' }
    });

    if (existing) {
      await removeUploadedFile(patternImagePath);
      return res.status(409).json({ error: 'Pattern number already exists' });
    }

    await PatternMaster.create({
      patternNumber,
      patternName,
      patternImagePath,
      assignedUserId: null,
      assignedUsername: null,
      isDiscarded: false
    });
    res.json({ success: true });
  } catch (error) {
    await removeUploadedFile(patternImagePath);
    res.status(500).json({ error: 'Error creating pattern' });
  }
});

// Admin: List Patterns
router.get('/patterns-list', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const search = (req.query.search || '').trim();
    const userId = (req.query.userId || '').trim();
    const filter = {};

    filter.isDiscarded = { $ne: true };

    if (search) {
      const regex = { $regex: escapeRegExp(search), $options: 'i' };
      filter.$or = [
        { patternNumber: regex },
        { patternName: regex }
      ];
    }

    if (userId && !isValidId(userId)) {
      return res.status(400).json({ error: 'Selected user is invalid' });
    }

    const patterns = await PatternMaster.find(filter).sort({ patternNumber: 1 }).lean();
    const patternNumbers = patterns.map(pattern => pattern.patternNumber).filter(Boolean);

    const recordMatch = {
      patternNumber: { $in: patternNumbers }
    };
    if (userId) {
      recordMatch.userId = userId;
    }

    const matchingRecords = await PatternRecord.find(recordMatch).sort({ recordDate: -1, createdAt: -1 });
    const latestMap = new Map();
    matchingRecords.forEach((record) => {
      const key = `${record.patternNumber}::${record.type}`;
      if (!latestMap.has(key)) {
        latestMap.set(key, {
          patternNumber: record.patternNumber,
          type: record.type,
          handoverTo: record.handoverTo,
          receiveFrom: record.receiveFrom,
          recordDate: record.recordDate,
          userId: record.userId
        });
      }
    });
    const latestByPatternAndType = Array.from(latestMap.values());

    const userIds = Array.from(new Set(latestByPatternAndType.map(row => String(row.userId || '')).filter(Boolean)));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id username').lean()
      : [];
    const userMap = new Map(users.map(user => [String(user._id), user.username]));

    const activityMap = new Map();
    latestByPatternAndType.forEach((row) => {
      const key = `${row.patternNumber}::${row.type}`;
      activityMap.set(key, {
        handoverTo: row.handoverTo || '',
        receiveFrom: row.receiveFrom || '',
        recordDate: row.recordDate || null,
        addedBy: row.userId ? (userMap.get(String(row.userId)) || '') : ''
      });
    });

    const responseRows = patterns.map((pattern) => {
      const handover = activityMap.get(`${pattern.patternNumber}::handover`) || null;
      const receive = activityMap.get(`${pattern.patternNumber}::receive`) || null;
      return {
        ...pattern,
        latestHandover: handover,
        latestReceive: receive
      };
    });

    // If user filter is applied, only show patterns with at least one record by that user.
    const filtered = userId
      ? responseRows.filter((row) => row.latestHandover || row.latestReceive)
      : responseRows;

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: 'Error loading patterns' });
  }
});

// Admin: list discarded patterns
router.get('/discarded-patterns-list', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const search = (req.query.search || '').trim();
    const filter = { isDiscarded: true };

    if (search) {
      const regex = { $regex: escapeRegExp(search), $options: 'i' };
      filter.$or = [
        { patternNumber: regex },
        { patternName: regex }
      ];
    }

    const patterns = await PatternMaster.find(filter).sort({ discardedAt: -1, patternNumber: 1 }).lean();
    return res.json(patterns);
  } catch (error) {
    return res.status(500).json({ error: 'Error loading discarded patterns' });
  }
});

// Admin: discard a pattern by pattern number
router.post('/discard-pattern', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const patternNumber = (req.body.patternNumber || '').trim();
  if (!patternNumber) {
    return res.status(400).json({ error: 'Pattern number is required' });
  }

  try {
    const pattern = await PatternMaster.findOne({
      patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' }
    });

    if (!pattern) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    if (pattern.isDiscarded) {
      return res.json({ success: true });
    }

    pattern.isDiscarded = true;
    pattern.discardedAt = new Date();
    pattern.discardedByUserId = req.session.userId;
    await pattern.save();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Error discarding pattern' });
  }
});

// Admin: restore a discarded pattern (add again) by pattern number
router.post('/restore-pattern', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const patternNumber = (req.body.patternNumber || '').trim();
  if (!patternNumber) {
    return res.status(400).json({ error: 'Pattern number is required' });
  }

  try {
    const pattern = await PatternMaster.findOne({
      patternNumber: { $regex: `^${escapeRegExp(patternNumber)}$`, $options: 'i' }
    });

    if (!pattern) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    if (!pattern.isDiscarded) {
      return res.json({ success: true });
    }

    pattern.isDiscarded = false;
    pattern.discardedAt = null;
    pattern.discardedByUserId = null;
    await pattern.save();

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Error restoring pattern' });
  }
});

// Admin: Delete Pattern Master
router.post('/delete-pattern/:id', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const pattern = await PatternMaster.findById(req.params.id);

    if (!pattern) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    await removeUploadedFile(pattern.patternImagePath);
    await PatternMaster.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting pattern' });
  }
});

// Supervisor list from users and pattern records
router.get('/supervisors', requireAuth, async (req, res) => {
  try {
    res.json(DEFAULT_PARTY_NAMES);
  } catch (error) {
    res.status(500).json({ error: 'Error loading supervisors' });
  }
});

// Admin: Pattern activity records with optional search and pattern number filters
router.get('/pattern-records', requireAuth, async (req, res) => {
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const search = (req.query.search || '').trim();
    const userId = (req.query.userId || '').trim();
    const patternNumber = (req.query.patternNumber || '').trim();
    console.log('pattern-records request', { userId, patternNumber, search, role: req.session.role, sessionUserId: req.session.userId });
    const filters = [];

    if (search) {
      const regex = { $regex: escapeRegExp(search), $options: 'i' };
      filters.push({ $or: [{ patternNumber: regex }, { patternName: regex }] });
    }

    if (userId) {
      if (isValidId(userId)) {
        filters.push({ userId });
      } else {
        console.warn('Invalid userId passed to /pattern-records:', userId);
        return res.json([]);
      }
    }

    if (patternNumber) {
      filters.push({
        patternNumber: {
          $regex: escapeRegExp(patternNumber),
          $options: 'i'
        }
      });
    }

    const query = filters.length === 0 ? {} : filters.length === 1 ? filters[0] : { $and: filters };
    const records = await PatternRecord.find(query)
      .populate('userId', 'username')
      .sort({ recordDate: -1, createdAt: -1 })
      .limit(50);
    res.json(records);
  } catch (error) {
    console.error('Error loading pattern records:', error);
    res.status(500).json({ error: 'Error loading pattern records' });
  }
});

// Export visible pattern records for current user (admins can optionally filter by userId).
router.get('/export/pattern-records.xlsx', requireAuth, async (req, res) => {
  try {
    const baseQuery = await getVisiblePatternRecordQuery(req);
    const searchFilter = buildSearchFilter(req.query.search);
    const patternNumberFilter = buildPatternNumberFilter(req.query.patternNumber);

    let userFilter = null;
    if (req.session.role === 'admin') {
      const userId = String(req.query.userId || '').trim();
      if (userId) {
        if (!isValidId(userId)) {
          return res.status(400).json({ error: 'Selected user is invalid' });
        }
        userFilter = { userId };
      }
    }

    const query = mergeQuery(baseQuery, searchFilter, patternNumberFilter, userFilter);
    const records = await PatternRecord.find(query)
      .populate('userId', 'username')
      .sort({ recordDate: -1, createdAt: -1 })
      .lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Mototek Pattern Management';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Pattern Records');

    sheet.columns = [
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Pattern Number', key: 'patternNumber', width: 22 },
      { header: 'Pattern Name', key: 'patternName', width: 34 },
      { header: 'Handover To', key: 'handoverTo', width: 20 },
      { header: 'Received From', key: 'receiveFrom', width: 20 },
      { header: 'Date', key: 'recordDate', width: 14 },
      { header: 'Added By', key: 'addedBy', width: 18 }
    ];

    records.forEach((record) => {
      const recordDate = record.recordDate ? new Date(record.recordDate) : null;
      sheet.addRow({
        type: record.type,
        patternNumber: record.patternNumber || '',
        patternName: record.patternName || '',
        handoverTo: record.handoverTo || '',
        receiveFrom: record.receiveFrom || '',
        recordDate: recordDate ? recordDate.toISOString().slice(0, 10) : '',
        addedBy: record.userId && record.userId.username ? record.userId.username : ''
      });
    });

    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length }
    };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="pattern-records.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting pattern records (xlsx):', error);
    return res.status(500).json({ error: 'Error exporting records' });
  }
});

router.get('/export/pattern-records.pdf', requireAuth, async (req, res) => {
  try {
    const baseQuery = await getVisiblePatternRecordQuery(req);
    const searchFilter = buildSearchFilter(req.query.search);
    const patternNumberFilter = buildPatternNumberFilter(req.query.patternNumber);

    let userFilter = null;
    if (req.session.role === 'admin') {
      const userId = String(req.query.userId || '').trim();
      if (userId) {
        if (!isValidId(userId)) {
          return res.status(400).json({ error: 'Selected user is invalid' });
        }
        userFilter = { userId };
      }
    }

    const query = mergeQuery(baseQuery, searchFilter, patternNumberFilter, userFilter);
    const records = await PatternRecord.find(query)
      .populate('userId', 'username')
      .sort({ recordDate: -1, createdAt: -1 })
      .lean();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="pattern-records.pdf"');

    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(16).text('Pattern Records', { align: 'left' });
    doc.moveDown(0.25);
    doc.fontSize(10).fillColor('#444').text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown(0.75);
    doc.fillColor('#000');

    if (records.length === 0) {
      doc.fontSize(12).text('No records found for the selected filter.');
      doc.end();
      return;
    }

    const colX = {
      date: 36,
      type: 92,
      pattern: 152,
      party: 312,
      addedBy: 470
    };

    function printHeader() {
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Date', colX.date, doc.y, { width: 54 });
      doc.text('Type', colX.type, doc.y, { width: 54 });
      doc.text('Pattern', colX.pattern, doc.y, { width: 160 });
      doc.text('Party', colX.party, doc.y, { width: 150 });
      doc.text('Added by', colX.addedBy, doc.y, { width: 100 });
      doc.moveDown(0.35);
      doc.font('Helvetica');
      doc.moveTo(36, doc.y).lineTo(559, doc.y).strokeColor('#e0e0e0').stroke();
      doc.moveDown(0.4);
    }

    printHeader();

    records.forEach((record) => {
      const recordDate = record.recordDate ? new Date(record.recordDate) : null;
      const dateText = recordDate ? recordDate.toISOString().slice(0, 10) : '';
      const typeText = record.type === 'handover' ? 'Handover' : 'Received';
      const patternText = `${record.patternNumber || ''}\n${record.patternName || ''}`.trim();
      const partyText = record.type === 'handover'
        ? `To: ${record.handoverTo || ''}`
        : `From: ${record.receiveFrom || ''}`;
      const addedBy = record.userId && record.userId.username ? record.userId.username : '';

      const rowTop = doc.y;
      doc.fontSize(9);
      doc.text(dateText, colX.date, rowTop, { width: 54 });
      doc.text(typeText, colX.type, rowTop, { width: 54 });
      doc.text(patternText, colX.pattern, rowTop, { width: 160 });
      doc.text(partyText, colX.party, rowTop, { width: 150 });
      doc.text(addedBy, colX.addedBy, rowTop, { width: 100 });

      const rowHeight = Math.max(
        doc.heightOfString(patternText, { width: 160 }),
        doc.heightOfString(partyText, { width: 150 }),
        12
      );
      doc.y = rowTop + rowHeight + 6;

      if (doc.y > doc.page.height - 72) {
        doc.addPage();
        printHeader();
      }
    });

    doc.end();
  } catch (error) {
    console.error('Error exporting pattern records (pdf):', error);
    return res.status(500).json({ error: 'Error exporting records' });
  }
});

// Session check for SPA refresh
router.get('/session', (req, res) => {
  if (req.session.userId && req.session.role) {
    return res.json({
      username: req.session.username || 'User',
      role: req.session.role,
      allowedPages: Array.isArray(req.session.allowedPages) ? req.session.allowedPages : null
    });
  }
  res.status(401).json({ error: 'Not authenticated' });
});

module.exports = router;

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PatternRecord = require('../models/PatternRecord');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const uploadDirectory = path.join(__dirname, '..', 'public', 'uploads');

function renderAddUser(res, options = {}) {
  const { status = 200, error = null, formData = {} } = options;

  return res.status(status).render('addUser', {
    error,
    formData: {
      username: formData.username || ''
    }
  });
}

// All routes require auth and admin
router.use(requireAuth, requireAdmin);

// Admin dashboard
router.get('/', async (req, res) => {
  const users = await User.find({ role: 'user' });
  const records = await PatternRecord.find().populate('userId').sort({ recordDate: -1, createdAt: -1 });
  res.render('adminDashboard', { users, records });
});

// Add user form
router.get('/add', (req, res) => {
  return renderAddUser(res);
});

// Add user post
router.post('/add', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!username || !password) {
    return renderAddUser(res, {
      status: 400,
      error: 'Username and password are required.',
      formData: { username }
    });
  }

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return renderAddUser(res, {
        status: 409,
        error: 'That username already exists. Please choose a different username.',
        formData: { username }
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword, role: 'user' });
    return res.redirect('/users');
  } catch (error) {
    if (error.code === 11000) {
      return renderAddUser(res, {
        status: 409,
        error: 'That username already exists. Please choose a different username.',
        formData: { username }
      });
    }

    return renderAddUser(res, {
      status: 500,
      error: 'Unable to create the user right now. Please try again.',
      formData: { username }
    });
  }
});

// Delete user
router.post('/delete/:id', async (req, res) => {
  const userRecords = await PatternRecord.find({ userId: req.params.id }).select('photoPath');

  await Promise.all(userRecords.map(async (record) => {
    if (!record.photoPath) {
      return;
    }

    const filePath = path.join(uploadDirectory, record.photoPath);

    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(error);
      }
    }
  }));

  await User.findByIdAndDelete(req.params.id);
  await PatternRecord.deleteMany({ userId: req.params.id });
  res.redirect('/users');
});

module.exports = router;

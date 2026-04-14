const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const router = express.Router();

// Login page
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Login post
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (user && await bcrypt.compare(password, user.password)) {
    req.session.userId = user._id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.allowedPages = Array.isArray(user.allowedPages) ? user.allowedPages : null;
    if (user.role === 'admin') {
      res.redirect('/users');
    } else {
      res.redirect('/patterns/dashboard');
    }
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;

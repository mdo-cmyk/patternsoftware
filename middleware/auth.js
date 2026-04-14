function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }

  if (req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') {
    return next();
  }

  if (req.originalUrl.startsWith('/api')) {
    return res.status(403).json({ error: 'Admin only' });
  }

  return res.status(403).send('Access denied');
}

module.exports = { requireAuth, requireAdmin };
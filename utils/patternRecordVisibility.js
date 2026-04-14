const User = require('../models/User');

function namesMatch(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function usernameFilter(username) {
  return { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
}

async function getSessionUsername(req) {
  if (req.session.username) {
    return req.session.username;
  }

  if (!req.session.userId) {
    return '';
  }

  const user = await User.findById(req.session.userId);
  if (!user) {
    return '';
  }

  req.session.username = user.username;
  return user.username;
}

async function getVisiblePatternRecordQuery(req) {
  if (req.session.role === 'admin') {
    return {};
  }

  const username = await getSessionUsername(req);
  const filters = [{ userId: req.session.userId }];

  if (username) {
    const exactUsername = usernameFilter(username);
    filters.push({ type: 'handover', handoverTo: exactUsername });
    filters.push({ type: 'receive', receiveFrom: exactUsername });
  }

  return { $or: filters };
}

async function canUsePatternRecord(req, record) {
  if (req.session.role === 'admin') {
    return true;
  }

  if (record.userId && record.userId.toString() === req.session.userId.toString()) {
    return true;
  }

  const username = await getSessionUsername(req);
  return (record.type === 'handover' && namesMatch(record.handoverTo, username))
    || (record.type === 'receive' && namesMatch(record.receiveFrom, username));
}

module.exports = {
  canUsePatternRecord,
  getVisiblePatternRecordQuery
};

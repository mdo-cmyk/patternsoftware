const DEFAULT_USER_ACCOUNTS = [
  {
    username: 'admin',
    password: 'admin123',
    role: 'admin',
    allowedPages: null
  },
  {
    username: 'pattern maker',
    password: 'patternmaker123',
    role: 'user',
    allowedPages: ['dashboard', 'handover', 'receive']
  }
];

// Party names used in "Received From" and "Handover To" dropdowns.
// Note: this is separate from login usernames/roles.
const DEFAULT_PARTY_NAMES = ['pattern maker', 'PDGPL'];
const HANDOVER_TO_DEFAULT = 'pattern maker';
const RECEIVE_FROM_DEFAULT = 'PDGPL';

module.exports = {
  DEFAULT_USER_ACCOUNTS,
  DEFAULT_PARTY_NAMES,
  HANDOVER_TO_DEFAULT,
  RECEIVE_FROM_DEFAULT
};

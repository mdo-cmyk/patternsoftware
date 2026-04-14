const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);
const path = require('path');
const User = require('./models/User');
const bcrypt = require('bcryptjs');
const {
  DEFAULT_USER_ACCOUNTS,
  DEFAULT_PARTY_NAMES,
  HANDOVER_TO_DEFAULT,
  RECEIVE_FROM_DEFAULT
} = require('./config/defaultUsers');

const app = express();
const databaseUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/mototekPatternManagement';
const sessionSecret = process.env.SESSION_SECRET || 'your-secret-key';

// Connect to MongoDB
mongoose.connect(databaseUrl)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Create initial users
mongoose.connection.once('open', async () => {
  for (const defaultUser of DEFAULT_USER_ACCOUNTS) {
    const userExists = await User.findOne({ username: defaultUser.username });
    if (!userExists) {
      const hashedPassword = await bcrypt.hash(defaultUser.password, 10);
      await User.create({
        username: defaultUser.username,
        password: hashedPassword,
        role: defaultUser.role,
        allowedPages: defaultUser.allowedPages
      });
      console.log(`Default user created: username: ${defaultUser.username}, password: ${defaultUser.password}`);
    }
  }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new MongoStore({ url: databaseUrl })
}));

// Routes
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/patterns', require('./routes/patterns'));

// Serve single-page application
app.get('/', (req, res) => {
  res.render('index', {
    defaultPartyNames: DEFAULT_PARTY_NAMES,
    handoverToDefault: HANDOVER_TO_DEFAULT,
    receiveFromDefault: RECEIVE_FROM_DEFAULT
  });
});

app.get('/admin', (req, res) => res.redirect('/'));
app.get('/motors', (req, res) => res.redirect('/'));
app.get(/^\/motors\/.*/, (req, res) => res.redirect('/'));

// Friendly fallback error page instead of raw stack traces in the browser
app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'The request could not be completed. Please go back and try again.'
  });
});

// Start server
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

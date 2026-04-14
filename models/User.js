const { FirestoreModel } = require('../db/modelHelpers');

class User extends FirestoreModel {}

User.collectionName = 'users';

module.exports = User;
const { FirestoreModel } = require('../db/modelHelpers');

class PatternMaster extends FirestoreModel {}

PatternMaster.collectionName = 'patternMasters';

module.exports = PatternMaster;

const { FirestoreModel } = require('../db/modelHelpers');

class PatternRecord extends FirestoreModel {}

PatternRecord.collectionName = 'patternRecords';

module.exports = PatternRecord;

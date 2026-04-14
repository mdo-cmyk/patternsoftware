const { randomUUID } = require('crypto');
const { db } = require('./firestore');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareValues(left, right, direction = 1) {
  if (left === right) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left > right) return 1 * direction;
  return -1 * direction;
}

function matchValue(docValue, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if (Object.prototype.hasOwnProperty.call(condition, '$regex')) {
      const pattern = condition.$regex;
      const flags = condition.$options || '';
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, flags);
      return regex.test(String(docValue || ''));
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$ne')) {
      return docValue !== condition.$ne;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$in')) {
      return condition.$in.map(String).includes(String(docValue));
    }
  }
  return String(docValue) === String(condition);
}

function matchesFilter(document, filter = {}) {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }

  if (Array.isArray(filter.$and)) {
    return filter.$and.every((item) => matchesFilter(document, item));
  }

  if (Array.isArray(filter.$or)) {
    return filter.$or.some((item) => matchesFilter(document, item));
  }

  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and' || key === '$or') {
      return true;
    }
    return matchValue(document[key], value);
  });
}

function projectDocument(document, fieldsString) {
  if (!fieldsString) {
    return document;
  }

  const fields = String(fieldsString)
    .split(/\s+/)
    .map((field) => field.trim())
    .filter(Boolean);

  if (fields.length === 0) {
    return document;
  }

  const projected = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(document, field)) {
      projected[field] = document[field];
    }
  });

  if (Object.prototype.hasOwnProperty.call(document, '_id')) {
    projected._id = document._id;
  }
  return projected;
}

class QueryChain {
  constructor(promise) {
    this.promise = promise;
  }

  sort(sortSpec = {}) {
    this.promise = this.promise.then((rows) => {
      const entries = Object.entries(sortSpec);
      const sorted = rows.map(clone).sort((left, right) => {
        for (const [field, rawDirection] of entries) {
          const direction = rawDirection === -1 ? -1 : 1;
          const result = compareValues(left[field], right[field], direction);
          if (result !== 0) {
            return result;
          }
        }
        return 0;
      });
      return sorted;
    });
    return this;
  }

  limit(count) {
    this.promise = this.promise.then((rows) => rows.slice(0, Number(count) || 0));
    return this;
  }

  select(fields) {
    this.promise = this.promise.then((rows) => rows.map((row) => projectDocument(row, fields)));
    return this;
  }

  populate(field, fields) {
    this.promise = this.promise.then(async (rows) => {
      if (field !== 'userId') {
        return rows;
      }
      // Lazy import to avoid cyclic deps.
      const User = require('../models/User');
      const allUsers = await User.find({});
      const userMap = new Map(allUsers.map((user) => [String(user._id), projectDocument(user, fields)]));
      return rows.map((row) => ({
        ...row,
        [field]: row[field] ? (userMap.get(String(row[field])) || null) : null
      }));
    });
    return this;
  }

  lean() {
    return this.promise.then((rows) => rows.map(clone));
  }

  then(resolve, reject) {
    return this.promise.then((rows) => rows.map(clone)).then(resolve, reject);
  }
}

class FirestoreModel {
  static collectionName = '';

  static collection() {
    return db.collection(this.collectionName);
  }

  static documentFromSnapshot(snapshot) {
    return { _id: snapshot.id, ...snapshot.data() };
  }

  static async allDocuments() {
    const snapshot = await this.collection().get();
    return snapshot.docs.map((doc) => this.documentFromSnapshot(doc));
  }

  static find(filter = {}) {
    const rowsPromise = this.allDocuments().then((rows) => rows.filter((row) => matchesFilter(row, filter)));
    return new QueryChain(rowsPromise);
  }

  static async findOne(filter = {}) {
    const rows = await this.find(filter);
    return rows[0] || null;
  }

  static async findById(id) {
    if (!id) return null;
    const snapshot = await this.collection().doc(String(id)).get();
    if (!snapshot.exists) return null;
    const document = this.documentFromSnapshot(snapshot);
    document.save = async () => {
      const { _id, ...payload } = document;
      payload.updatedAt = new Date().toISOString();
      await this.collection().doc(String(_id)).set(payload, { merge: true });
      return document;
    };
    return document;
  }

  static async create(data) {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const payload = {
      ...data,
      createdAt: data.createdAt || timestamp,
      updatedAt: timestamp
    };
    await this.collection().doc(id).set(payload);
    return { _id: id, ...payload };
  }

  static async findByIdAndDelete(id) {
    if (!id) return null;
    const current = await this.findById(id);
    if (!current) return null;
    await this.collection().doc(String(id)).delete();
    return current;
  }

  static async deleteMany(filter = {}) {
    const rows = await this.find(filter);
    await Promise.all(rows.map((row) => this.collection().doc(String(row._id)).delete()));
    return { deletedCount: rows.length };
  }

  static async countDocuments(filter = {}) {
    const rows = await this.find(filter);
    return rows.length;
  }

  static async distinct(field, filter = {}) {
    const rows = await this.find(filter);
    return Array.from(new Set(rows.map((row) => row[field]).filter((value) => value !== undefined)));
  }

  static async updateMany(filter = {}, update = {}) {
    const rows = await this.find(filter);
    const setValues = update.$set || {};
    await Promise.all(
      rows.map((row) => this.collection().doc(String(row._id)).set({
        ...setValues,
        updatedAt: new Date().toISOString()
      }, { merge: true }))
    );
    return { modifiedCount: rows.length };
  }
}

function isValidId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = {
  FirestoreModel,
  QueryChain,
  matchesFilter,
  isValidId
};

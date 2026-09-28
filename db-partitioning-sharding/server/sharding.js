const path = require('path');
const { naiveModShard, ConsistentHashRing } = require('./lib/hashing');
const { writeJSON, clearDir } = require('./lib/store');

const DATA_DIR = path.join(__dirname, 'data');
const NAIVE_DIR = path.join(DATA_DIR, 'shards-naive');
const CONSISTENT_DIR = path.join(DATA_DIR, 'shards-consistent');

const FIRST_NAMES = ['Ava', 'Liam', 'Noor', 'Sara', 'Omar', 'Zara', 'Ali', 'Mia', 'Noah', 'Hana', 'Yusuf', 'Lina', 'Adam', 'Amir', 'Ella', 'Sami'];
const LAST_NAMES = ['Khan', 'Ahmed', 'Malik', 'Siddiqui', 'Raza', 'Sheikh', 'Iqbal', 'Farooq', 'Butt', 'Hussain'];

class ShardingWorld {
  constructor() {
    this.reset();
  }

  reset() {
    this.shardCount = 4;
    this.nextShardId = 4;
    this.activeShardIds = [0, 1, 2, 3];
    this.ring = new ConsistentHashRing(12);
    for (const id of this.activeShardIds) this.ring.addShard(id);
    this.users = []; // { id, name, createdAt }
    this.nextUserId = 1;
    this.lastRebalance = null; // stats from the most recent add/remove shard op
    clearDir(NAIVE_DIR);
    clearDir(CONSISTENT_DIR);
    this._seed(48);
    this._persist();
  }

  _seed(count) {
    for (let i = 0; i < count; i++) {
      const name = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 3) % LAST_NAMES.length]}`;
      this._addUserRecord(name);
    }
  }

  _addUserRecord(name) {
    const id = `u${this.nextUserId++}`;
    this.users.push({ id, name, createdAt: new Date().toISOString() });
    return id;
  }

  _placements() {
    const naive = new Map();
    const consistent = new Map();
    for (const user of this.users) {
      naive.set(user.id, naiveModShard(user.id, this.shardCount));
      consistent.set(user.id, this.ring.getShardForKey(user.id));
    }
    return { naive, consistent };
  }

  _persist() {
    const { naive, consistent } = this._placements();
    this._writeShardFiles(NAIVE_DIR, naive, this.activeShardIds);
    this._writeShardFiles(CONSISTENT_DIR, consistent, this.activeShardIds);
    this._currentPlacements = { naive, consistent };
  }

  _writeShardFiles(dir, placementMap, shardIds) {
    const byShard = new Map(shardIds.map((id) => [id, []]));
    for (const user of this.users) {
      const shardId = placementMap.get(user.id);
      if (!byShard.has(shardId)) byShard.set(shardId, []);
      byShard.get(shardId).push(user);
    }
    for (const [shardId, records] of byShard) {
      writeJSON(path.join(dir, `shard-${shardId}.json`), { shardId, count: records.length, records });
    }
  }

  addUser(name) {
    const id = this._addUserRecord(name || `Guest ${this.nextUserId}`);
    this._persist();
    return this.getUserView(id);
  }

  getUserView(id) {
    const user = this.users.find((u) => u.id === id);
    if (!user) return null;
    return {
      ...user,
      naiveShard: this._currentPlacements.naive.get(id),
      consistentShard: this._currentPlacements.consistent.get(id),
    };
  }

  _rebalance(mutate) {
    const before = this._placements();
    mutate();
    const after = this._placements();

    let movedNaive = 0;
    let movedConsistent = 0;
    const movedIds = new Set();
    for (const user of this.users) {
      if (before.naive.get(user.id) !== after.naive.get(user.id)) movedNaive++;
      if (before.consistent.get(user.id) !== after.consistent.get(user.id)) {
        movedConsistent++;
        movedIds.add(user.id);
      }
    }

    const total = this.users.length;
    this.lastRebalance = {
      totalKeys: total,
      movedNaive,
      movedConsistent,
      movedNaivePct: total ? +(100 * movedNaive / total).toFixed(1) : 0,
      movedConsistentPct: total ? +(100 * movedConsistent / total).toFixed(1) : 0,
      movedConsistentIds: [...movedIds],
      shardCount: this.shardCount,
    };
    this._persist();
  }

  addShard() {
    this._rebalance(() => {
      const newId = this.nextShardId++;
      this.activeShardIds.push(newId);
      this.shardCount = this.activeShardIds.length;
      this.ring.addShard(newId);
    });
    return this.lastRebalance;
  }

  removeShard() {
    if (this.activeShardIds.length <= 2) {
      throw new Error('At least 2 shards are required for the demo.');
    }
    this._rebalance(() => {
      const removedId = this.activeShardIds.pop();
      this.shardCount = this.activeShardIds.length;
      this.ring.removeShard(removedId);
    });
    return this.lastRebalance;
  }

  getState() {
    const { naive, consistent } = this._currentPlacements;
    const naiveCounts = new Map(this.activeShardIds.map((id) => [id, 0]));
    const consistentCounts = new Map(this.activeShardIds.map((id) => [id, 0]));
    for (const user of this.users) {
      naiveCounts.set(naive.get(user.id), (naiveCounts.get(naive.get(user.id)) || 0) + 1);
      consistentCounts.set(consistent.get(user.id), (consistentCounts.get(consistent.get(user.id)) || 0) + 1);
    }
    return {
      shardCount: this.shardCount,
      activeShardIds: this.activeShardIds,
      users: this.users.map((u) => this.getUserView(u.id)),
      naiveCounts: Object.fromEntries(naiveCounts),
      consistentCounts: Object.fromEntries(consistentCounts),
      ring: this.ring.getSnapshot(),
      lastRebalance: this.lastRebalance,
    };
  }
}

module.exports = { ShardingWorld };

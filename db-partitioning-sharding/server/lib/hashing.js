const crypto = require('crypto');

const RING_SIZE = 2 ** 32;

function hashToInt(str) {
  const digest = crypto.createHash('sha1').update(String(str)).digest('hex');
  return parseInt(digest.slice(0, 8), 16);
}

function naiveModShard(key, shardCount) {
  return hashToInt(key) % shardCount;
}

class ConsistentHashRing {
  constructor(virtualNodesPerShard = 12) {
    this.virtualNodesPerShard = virtualNodesPerShard;
    this.points = []; // [{ position, shardId }], kept sorted by position
    this.shardIds = new Set();
  }

  addShard(shardId) {
    if (this.shardIds.has(shardId)) return;
    this.shardIds.add(shardId);
    for (let v = 0; v < this.virtualNodesPerShard; v++) {
      const position = hashToInt(`shard-${shardId}-vnode-${v}`);
      this.points.push({ position, shardId });
    }
    this.points.sort((a, b) => a.position - b.position);
  }

  removeShard(shardId) {
    if (!this.shardIds.has(shardId)) return;
    this.shardIds.delete(shardId);
    this.points = this.points.filter((p) => p.shardId !== shardId);
  }

  getShardForKey(key) {
    if (this.points.length === 0) return null;
    const target = hashToInt(key);
    // First virtual node whose position is >= target, wrapping to the start of the ring.
    let lo = 0;
    let hi = this.points.length - 1;
    if (target > this.points[hi].position) return this.points[0].shardId;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].position < target) lo = mid + 1;
      else hi = mid;
    }
    return this.points[lo].shardId;
  }

  getSnapshot() {
    return {
      ringSize: RING_SIZE,
      virtualNodesPerShard: this.virtualNodesPerShard,
      shardIds: [...this.shardIds].sort((a, b) => a - b),
      points: this.points.map((p) => ({ position: p.position, shardId: p.shardId })),
    };
  }
}

module.exports = { hashToInt, naiveModShard, ConsistentHashRing, RING_SIZE };

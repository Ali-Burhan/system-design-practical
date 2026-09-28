const express = require('express');
const { ShardingWorld } = require('./sharding');
const { PartitioningWorld } = require('./partitioning');

const shardingWorld = new ShardingWorld();
const partitioningWorld = new PartitioningWorld();

const router = express.Router();

function handle(fn) {
  return (req, res) => {
    try {
      res.json(fn(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

// --- Sharding demo (Users) ---
router.get('/sharding/state', handle(() => shardingWorld.getState()));
router.post('/sharding/users', handle((req) => shardingWorld.addUser(req.body.name)));
router.post('/sharding/shards/add', handle(() => shardingWorld.addShard()));
router.post('/sharding/shards/remove', handle(() => shardingWorld.removeShard()));
router.post('/sharding/reset', handle(() => {
  shardingWorld.reset();
  return shardingWorld.getState();
}));

// --- Partitioning demo (Orders) ---
router.get('/partitioning/state', handle(() => partitioningWorld.getState()));
router.post('/partitioning/orders', handle((req) => partitioningWorld.addOrder(req.body)));
router.post('/partitioning/query', handle((req) => partitioningWorld.query(req.body)));
router.post('/partitioning/reset', handle(() => {
  partitioningWorld.reset();
  return partitioningWorld.getState();
}));

module.exports = router;

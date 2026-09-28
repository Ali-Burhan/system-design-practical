const path = require('path');
const { writeJSON, clearDir } = require('./lib/store');

const DATA_DIR = path.join(__dirname, 'data', 'partitions');

const PER_ROW_MS = 0.06;
const PARTITION_OVERHEAD_MS = 3.2;

const CUSTOMERS = ['Acme Co', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Ent.', 'Wonka Inc', 'Soylent', 'Aperture'];

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function monthRange(startKey, endKey) {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  const keys = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return keys;
}

class PartitioningWorld {
  constructor() {
    this.reset();
  }

  reset() {
    this.partitions = new Map(); // key -> records[]
    this.nextOrderId = 1;
    clearDir(DATA_DIR);
    this._seed();
    this._persist();
  }

  _addOrderRecord({ customer, amount, date }) {
    const key = monthKey(date);
    if (!this.partitions.has(key)) this.partitions.set(key, []);
    const record = {
      id: `o${this.nextOrderId++}`,
      customer,
      amount: Math.round(Number(amount) * 100) / 100,
      date,
    };
    this.partitions.get(key).push(record);
    return record;
  }

  _seed() {
    const year = 2025;
    for (let m = 1; m <= 12; m++) {
      const rows = 15 + Math.round(20 * Math.sin(m / 2) ** 2) + (m % 3) * 10;
      for (let i = 0; i < rows; i++) {
        const day = 1 + (i % 27);
        const date = `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const customer = CUSTOMERS[(m + i) % CUSTOMERS.length];
        const amount = 20 + ((m * 37 + i * 13) % 480);
        this._addOrderRecord({ customer, amount, date });
      }
    }
  }

  _persist() {
    for (const [key, records] of this.partitions) {
      writeJSON(path.join(DATA_DIR, `orders_${key.replace('-', '_')}.json`), {
        partition: key,
        count: records.length,
        records,
      });
    }
  }

  addOrder({ customer, amount, date }) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
    if (!customer) throw new Error('customer is required');
    const record = this._addOrderRecord({ customer, amount: amount || 0, date });
    this._persist();
    return { ...record, partition: monthKey(date) };
  }

  getState() {
    const partitions = [...this.partitions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, records]) => ({ key, count: records.length }));
    const totalRows = partitions.reduce((s, p) => s + p.count, 0);
    return { partitions, totalRows };
  }

  query({ start, end }) {
    if (!start || !end) throw new Error('start and end are required (YYYY-MM-DD)');
    const startKey = monthKey(start);
    const endKey = monthKey(end);
    const allKeys = [...this.partitions.keys()].sort();
    const candidateKeys = monthRange(startKey, endKey).filter((k) => this.partitions.has(k));

    let rowsScanned = 0;
    const matched = [];
    for (const key of candidateKeys) {
      const records = this.partitions.get(key) || [];
      rowsScanned += records.length;
      for (const r of records) {
        if (r.date >= start && r.date <= end) matched.push(r);
      }
    }

    const totalRows = allKeys.reduce((s, k) => s + this.partitions.get(k).length, 0);
    const partitionedTimeMs = candidateKeys.length * PARTITION_OVERHEAD_MS + rowsScanned * PER_ROW_MS;
    const fullScanTimeMs = PARTITION_OVERHEAD_MS + totalRows * PER_ROW_MS;

    return {
      start,
      end,
      matched,
      matchedCount: matched.length,
      partitionsTotal: allKeys.length,
      partitionsScanned: candidateKeys.length,
      partitionsSkipped: allKeys.length - candidateKeys.length,
      scannedKeys: candidateKeys,
      allKeys,
      rowsScanned,
      totalRows,
      simulated: {
        partitionedTimeMs: +partitionedTimeMs.toFixed(2),
        fullScanTimeMs: +fullScanTimeMs.toFixed(2),
        speedup: +(fullScanTimeMs / Math.max(partitionedTimeMs, 0.001)).toFixed(2),
      },
    };
  }
}

module.exports = { PartitioningWorld };

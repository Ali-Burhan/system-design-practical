const API = '/api';

function colorForShard(id) {
  const hue = (Number(id) * 63) % 360;
  return `hsl(${hue} 70% 58%)`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.appendChild(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Sharding tab
// ---------------------------------------------------------------------------
let shardChart = null;
let lastMovedIds = new Set();

function renderRing(ring) {
  const svg = document.getElementById('ring-svg');
  svg.innerHTML = '';
  const cx = 180, cy = 180, r = 140;
  svg.appendChild(svgEl('circle', {
    cx, cy, r, fill: 'none', stroke: '#263050', 'stroke-width': '1.5',
  }));
  for (const point of ring.points) {
    const angle = (point.position / ring.ringSize) * 2 * Math.PI - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    svg.appendChild(svgEl('circle', {
      cx: x.toFixed(1), cy: y.toFixed(1), r: 5,
      fill: colorForShard(point.shardId),
      stroke: '#0b0f19', 'stroke-width': '1',
    }));
  }
  svg.appendChild(svgEl('circle', { cx, cy, r: 3, fill: '#e7ecf8' }));

  const legend = document.getElementById('ring-legend');
  legend.innerHTML = '';
  for (const shardId of ring.shardIds) {
    const entry = el('span', {}, [
      el('span', { class: 'swatch', style: `background:${colorForShard(shardId)}` }),
    ]);
    entry.append(`shard ${shardId}`);
    legend.appendChild(entry);
  }
}

function renderShardChart(state) {
  const ctx = document.getElementById('shard-distribution-chart');
  const labels = state.activeShardIds.map((id) => `shard ${id}`);
  const naiveData = state.activeShardIds.map((id) => state.naiveCounts[id] || 0);
  const consistentData = state.activeShardIds.map((id) => state.consistentCounts[id] || 0);

  if (shardChart) shardChart.destroy();
  shardChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Naive mod-hash', data: naiveData, backgroundColor: '#ff6b81' },
        { label: 'Consistent hashing', data: consistentData, backgroundColor: '#4ade80' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#93a0bd' } } },
      scales: {
        x: { ticks: { color: '#93a0bd' }, grid: { color: '#1a2338' } },
        y: { ticks: { color: '#93a0bd' }, grid: { color: '#1a2338' }, beginAtZero: true },
      },
    },
  });
}

function renderUsersTable(state) {
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  for (const user of state.users) {
    const tr = el('tr', {});
    if (lastMovedIds.has(user.id)) tr.classList.add('moved');
    tr.appendChild(el('td', { text: user.id }));
    tr.appendChild(el('td', { text: user.name }));
    const naiveBadge = el('span', { class: 'badge', text: `shard ${user.naiveShard}`, style: `background:${colorForShard(user.naiveShard)}` });
    const consistentBadge = el('span', { class: 'badge', text: `shard ${user.consistentShard}`, style: `background:${colorForShard(user.consistentShard)}` });
    tr.appendChild(el('td', {}, [naiveBadge]));
    tr.appendChild(el('td', {}, [consistentBadge]));
    tbody.appendChild(tr);
  }
  document.getElementById('user-count-hint').textContent = `(${state.users.length} total, ${state.shardCount} shards)`;
}

function renderRebalanceBanner(result) {
  const banner = document.getElementById('rebalance-banner');
  if (!result) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = '';
  banner.appendChild(el('h4', { text: `Resharding to ${result.shardCount} shards — ${result.totalKeys} keys checked` }));
  const row = el('div', { class: 'compare-row' });

  const makeItem = (label, pct, cls) => {
    const item = el('div', { class: 'compare-item' });
    item.appendChild(el('div', { text: label }));
    const track = el('div', { class: 'compare-bar-track' });
    track.appendChild(el('div', { class: `compare-bar-fill ${cls}`, style: `width:${pct}%` }));
    item.appendChild(track);
    item.appendChild(el('div', { text: `${pct}%` }));
    return item;
  };

  row.appendChild(makeItem('Naive mod-hash', result.movedNaivePct, 'naive'));
  row.appendChild(makeItem('Consistent hash', result.movedConsistentPct, 'consistent'));
  banner.appendChild(row);
  banner.appendChild(el('p', {
    class: 'rebalance-note',
    text: `Naive mod-hashing had to move ${result.movedNaive} of ${result.totalKeys} keys (${result.movedNaivePct}%) because hash(id) % N changes for almost everyone when N changes. Consistent hashing only moved ${result.movedConsistent} keys (${result.movedConsistentPct}%) — just the ones that landed between the new shard's virtual nodes and its neighbor.`,
  }));
}

async function refreshSharding(rebalanceResult) {
  const state = await api('/sharding/state');
  renderRing(state.ring);
  renderShardChart(state);
  renderUsersTable(state);
  renderRebalanceBanner(rebalanceResult !== undefined ? rebalanceResult : state.lastRebalance);
  document.getElementById('remove-shard-btn').disabled = state.activeShardIds.length <= 2;
}

document.getElementById('add-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('user-name');
  const name = input.value.trim();
  input.value = '';
  const user = await api('/sharding/users', { method: 'POST', body: JSON.stringify({ name }) });
  lastMovedIds = new Set([user.id]);
  await refreshSharding(null);
});

document.getElementById('add-shard-btn').addEventListener('click', async () => {
  const result = await api('/sharding/shards/add', { method: 'POST' });
  lastMovedIds = new Set(result.movedConsistentIds);
  await refreshSharding(result);
});

document.getElementById('remove-shard-btn').addEventListener('click', async () => {
  try {
    const result = await api('/sharding/shards/remove', { method: 'POST' });
    lastMovedIds = new Set(result.movedConsistentIds);
    await refreshSharding(result);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('reset-sharding-btn').addEventListener('click', async () => {
  lastMovedIds = new Set();
  await api('/sharding/reset', { method: 'POST' });
  await refreshSharding(null);
});

// ---------------------------------------------------------------------------
// Partitioning tab
// ---------------------------------------------------------------------------
function renderPartitionTimeline(partitionState, scannedKeys, allKeys) {
  const wrap = document.getElementById('partition-timeline');
  wrap.innerHTML = '';
  const scannedSet = new Set(scannedKeys || []);
  const hasQuery = Array.isArray(scannedKeys);
  for (const p of partitionState.partitions) {
    const block = el('div', { class: 'partition-block' });
    if (hasQuery) block.classList.add(scannedSet.has(p.key) ? 'scanned' : 'skipped');
    block.appendChild(el('div', { class: 'p-key', text: p.key }));
    block.appendChild(el('div', { class: 'p-count', text: String(p.count) }));
    wrap.appendChild(block);
  }
}

async function refreshPartitioning() {
  const state = await api('/partitioning/state');
  renderPartitionTimeline(state, null, null);
  return state;
}

document.getElementById('add-order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customer = document.getElementById('order-customer').value.trim() || 'Anonymous';
  const amount = document.getElementById('order-amount').value || 0;
  const date = document.getElementById('order-date').value;
  await api('/partitioning/orders', { method: 'POST', body: JSON.stringify({ customer, amount, date }) });
  document.getElementById('order-customer').value = '';
  document.getElementById('order-amount').value = '';
  await refreshPartitioning();
});

document.getElementById('reset-partitioning-btn').addEventListener('click', async () => {
  await api('/partitioning/reset', { method: 'POST' });
  document.getElementById('query-result').innerHTML = 'Run a query to see partition pruning stats.';
  document.querySelector('#orders-table tbody').innerHTML = '';
  document.getElementById('matched-count-hint').textContent = '';
  await refreshPartitioning();
});

document.getElementById('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = document.getElementById('query-start').value;
  const end = document.getElementById('query-end').value;
  const result = await api('/partitioning/query', { method: 'POST', body: JSON.stringify({ start, end }) });

  const state = await api('/partitioning/state');
  renderPartitionTimeline(state, result.scannedKeys, result.allKeys);

  const resultBox = document.getElementById('query-result');
  resultBox.innerHTML = '';
  const cards = el('div', { class: 'result-cards' });
  cards.appendChild(el('div', { class: 'result-card win' }, [
    el('div', { class: 'label', text: 'With partitioning' }),
    el('div', { class: 'value', text: `${result.simulated.partitionedTimeMs} ms` }),
    el('div', { class: 'sub', text: `${result.partitionsScanned}/${result.partitionsTotal} partitions · ${result.rowsScanned} rows scanned` }),
  ]));
  cards.appendChild(el('div', { class: 'result-card lose' }, [
    el('div', { class: 'label', text: 'Without partitioning' }),
    el('div', { class: 'value', text: `${result.simulated.fullScanTimeMs} ms` }),
    el('div', { class: 'sub', text: `1 table · ${result.totalRows} rows scanned` }),
  ]));
  resultBox.appendChild(cards);
  const speedupLine = el('p', { class: 'speedup-line' });
  speedupLine.innerHTML = `Matched <strong>${result.matchedCount}</strong> orders. Partition pruning skipped ${result.partitionsSkipped} of ${result.partitionsTotal} partitions &rarr; <strong>${result.simulated.speedup}&times; faster</strong> (simulated).`;
  resultBox.appendChild(speedupLine);

  const tbody = document.querySelector('#orders-table tbody');
  tbody.innerHTML = '';
  for (const o of result.matched.slice(0, 200)) {
    const tr = el('tr', {});
    tr.appendChild(el('td', { text: o.id }));
    tr.appendChild(el('td', { text: o.customer }));
    tr.appendChild(el('td', { text: `$${o.amount.toFixed(2)}` }));
    tr.appendChild(el('td', { text: o.date }));
    tr.appendChild(el('td', { text: o.date.slice(0, 7) }));
    tbody.appendChild(tr);
  }
  document.getElementById('matched-count-hint').textContent = `(showing ${Math.min(200, result.matched.length)} of ${result.matchedCount})`;
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
refreshSharding(null);
refreshPartitioning();

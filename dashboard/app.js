/* Token Launch Radar — app.js
   Renders window.RADAR (written beside this file as data.dat by main.ts):
   a sortable, filterable board of pre-token protocols ranked by implied
   value, a per-protocol detail drawer with the model breakdown and the farm
   plan, plus launched comparables and the screened-out set for context. */

(function () {
  'use strict';

  var R = window.RADAR;
  var view = document.getElementById('view');

  // ---------- state ----------

  var state = {
    tab: 'radar',
    sortKey: 'rank',
    sortDir: 1,
    q: '',
    category: '',
    chain: '',
    wlOnly: false,
    selected: null
  };

  // ---------- formatting ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return '&' + '#' + c.charCodeAt(0) + ';';
    });
  }

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + Math.round(n);
  }

  function fmtMult(x) { return x.toFixed(2) + 'x'; }

  function chgCell(c) {
    if (c === null || c === undefined) return '<td class="num flat" title="unreported in the snapshot">n/r</td>';
    var cls = c > 0.005 ? 'up' : c < -0.005 ? 'down' : 'flat';
    return '<td class="num ' + cls + '">' + (c >= 0 ? '+' : '') + c.toFixed(2) + '%</td>';
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return 'n/r';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  // ---------- header ----------

  document.getElementById('asof').textContent = R.as_of;

  var statsEl = document.getElementById('stats');
  statsEl.innerHTML =
    stat(R.stats.protocols, 'protocols') +
    stat(R.stats.pre_token, 'no token') +
    stat(R.stats.candidates, 'candidates') +
    stat(R.stats.watchlist, 'watchlist') +
    stat(R.stats.launched_with_mcap, 'launched');

  function stat(v, k) {
    return '<div class="stat"><b>' + v + '</b><span>' + k + '</span></div>';
  }

  var f = R.model.formula;
  document.getElementById('formula').innerHTML =
    '<b>model</b> <span class="fx">' + esc(f).replace(/implied_value_usd/, '<i>implied_value_usd</i>') + '</span>' +
    '<span>&middot; category multiple = median mcap/TVL the market pays for launched tokens in that category</span>' +
    '<span>&middot; momentum = 7-day TVL trend, clamped 0.55x&ndash;2.5x</span>' +
    '<span>&middot; loyalty = up to +50% for years of TVL held with no token</span>';

  document.getElementById('n-radar').textContent = R.rows.length;
  document.getElementById('n-launched').textContent = R.launched.length;
  document.getElementById('n-screened').textContent = R.screened.length;

  // ---------- selects ----------

  var cats = {};
  var chains = {};
  R.rows.forEach(function (r) {
    cats[r.category || '(none)'] = true;
    r.chains.forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
  });
  fillSelect('category', Object.keys(cats).sort());
  fillSelect('chain', Object.keys(chains).sort(function (a, b) { return chains[b] - chains[a] || (a < b ? -1 : 1); }));

  function fillSelect(id, opts) {
    var sel = document.getElementById(id);
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o; el.textContent = o;
      sel.appendChild(el);
    });
  }

  // ---------- radar table ----------

  var COLS = [
    { key: 'rank', label: '#', cls: '' },
    { key: 'name', label: 'Protocol', cls: 'l' },
    { key: 'category', label: 'Category', cls: 'l' },
    { key: 'chains', label: 'Chains', cls: 'l' },
    { key: 'tvl', label: 'TVL', cls: '' },
    { key: 'chg', label: '7d', cls: '' },
    { key: 'age', label: 'Age', cls: '' },
    { key: 'value', label: 'Implied value', cls: '' },
    { key: 'src', label: 'Source', cls: '' }
  ];

  function visibleRows() {
    var q = state.q.toLowerCase();
    var out = R.rows.filter(function (r) {
      if (state.wlOnly && !r.watchlist) return false;
      if (state.category && (r.category || '(none)') !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var k = state.sortKey, d = state.sortDir;
    var val = {
      rank: function (r) { return r.rank; },
      name: function (r) { return r.name.toLowerCase(); },
      category: function (r) { return (r.category || '~').toLowerCase(); },
      chains: function (r) { return -r.chains.length; },
      tvl: function (r) { return r.tvl_usd; },
      chg: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      age: function (r) { return r.model.days_tracked === null ? -1 : r.model.days_tracked; },
      value: function (r) { return r.implied_value_usd; },
      src: function (r) { return r.watchlist ? 1 : 0; }
    }[k];
    out.sort(function (a, b) {
      var va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * d || a.rank - b.rank;
    });
    return out;
  }

  function headRow() {
    return COLS.map(function (c) {
      var on = state.sortKey === c.key;
      var ar = on ? ' <span class="arrow">' + (state.sortDir === 1 ? '&#9650;' : '&#9660;') + '</span>' : '';
      return '<th class="' + c.cls + (on ? ' sorted' : '') + '" data-k="' + c.key + '">' + c.label + ar + '</th>';
    }).join('');
  }

  function radarTable(rows) {
    var body = rows.map(function (r) {
      return '<tr class="r' + r.rank + (state.selected === r.slug ? ' sel' : '') + '" data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="l"><div class="proto"><b>' + esc(r.name) + '</b><span>' + esc(r.slug) + '</span></div></td>' +
        '<td class="l cat">' + esc(r.category || '(none)') + '</td>' +
        '<td class="l chains" title="' + esc(r.chains.join(', ')) + '">' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num tvl">' + fmtUsd(r.tvl_usd) + '</td>' +
        chgCell(r.change_7d) +
        '<td class="num age">' + fmtAge(r.model.days_tracked) + '</td>' +
        '<td class="num val">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td>' + (r.watchlist ? '<span class="badge wl" title="on the house watchlist: $50M+ TVL, no token recorded, not a wrapped or staked product">WL</span>' : '<span class="badge found" title="found by the radar below the watchlist floor">FOUND</span>') + '</td>' +
        '</tr>';
    }).join('');
    var n = rows.length;
    return '<table><thead><tr>' + headRow() + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="empty" style="display:' + (n ? 'none' : 'block') + '">no protocols match the current filter</p>';
  }

  // ---------- launched table ----------

  function launchedTable() {
    var rows = R.launched.map(function (r) {
      return '<tr>' +
        '<td class="l"><div class="proto"><b>' + esc(r.name) + '</b><span>' + esc(r.slug) + '</span></div></td>' +
        '<td class="l cat">' + esc(r.category || '(none)') + '</td>' +
        '<td class="num tvl">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num" style="color:var(--blue)">' + fmtMult(r.multiple) + '</td>' +
        '</tr>';
    }).join('');
    return '<p class="tabnote">Tokens that already trade, sorted by mcap. The <b>mcap/TVL multiple</b> column is the ' +
      'market&rsquo;s own price for a dollar of TVL in each category &mdash; the radar takes its category multiples from ' +
      'exactly these numbers, so every implied value on the board is anchored to what comparable launches are worth today.</p>' +
      '<table><thead><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Mcap</th><th>Mcap/TVL</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---------- screened table ----------

  function screenedTable() {
    var rows = R.screened.map(function (r) {
      return '<tr>' +
        '<td class="l"><div class="proto"><b>' + esc(r.name) + '</b><span>' + esc(r.slug) + '</span></div></td>' +
        '<td class="l cat">' + esc(r.category || '(none)') + '</td>' +
        '<td class="num tvl">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="l" style="color:var(--muted);white-space:normal">' + esc(r.reason) + '</td>' +
        '</tr>';
    }).join('');
    return '<p class="tabnote">Pre-token protocols the radar screens out before ranking: exchange balance sheets, bridge ' +
      'collateral and wrapped or staked products of assets that already trade. The house watchlist applies the same ' +
      'judgment above the $' + Math.round(R.floor_usd / 1e6) + 'M floor; this screen extends it below, and never removes a watchlist name.</p>' +
      '<table><thead><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th class="l">Why screened out</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---------- detail drawer ----------

  var drawer = document.getElementById('drawer');
  var drawerBody = document.getElementById('drawer-body');
  var veil = document.getElementById('veil');

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === slug) { r = R.rows[i]; break; }
    if (!r) return;
    state.selected = slug;
    var m = r.model;
    drawerBody.innerHTML =
      '<div class="d-head"><h2>' + esc(r.name) + '</h2><span class="rk">rank #' + r.rank + ' of ' + R.rows.length + '</span></div>' +
      '<div class="d-slug">' + esc(r.slug) + ' &middot; ' + esc(r.category || 'no category') + ' &middot; ' + esc(r.chains.join(', ')) + '</div>' +
      '<div class="d-val"><div class="lab">implied token value</div><div class="big">' + fmtUsd(r.implied_value_usd) + '</div>' +
      '<div class="note">what a token would be worth if the record stayed as it is &mdash; the model&rsquo;s claim, not a prediction one ships</div></div>' +
      '<div class="d-grid">' +
      dcell('TVL', fmtUsd(r.tvl_usd)) +
      dcell('7d TVL change', r.change_7d === null ? 'n/r' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') +
      dcell('tracked age', fmtAge(m.days_tracked) + (r.listed_at ? ' (since ' + esc(r.listed_at) + ')' : '')) +
      dcell('chains', String(r.chains.length)) +
      dcell('house watchlist', r.watchlist ? 'yes' : 'no &mdash; radar find') +
      dcell('token recorded', 'none') +
      '</div>' +
      '<div class="d-model"><h3>how the value is built</h3>' +
      '<div class="fx-line"><i>implied</i> = <b>' + fmtMult(m.category_multiple) + '</b> &times; TVL ' + fmtUsd(r.tvl_usd) +
      ' &times; <i>momentum</i> <b>' + fmtMult(m.momentum) + '</b> &times; <i>loyalty</i> <b>' + fmtMult(m.loyalty) + '</b> &asymp; <b>' + fmtUsd(r.implied_value_usd) + '</b></div>' +
      '<div class="fx-note">category multiple ' + fmtMult(m.category_multiple) + ' is the median mcap/TVL of the ' + m.launched_sample +
      ' launched tokens DefiLlama records in this category; momentum ' + fmtMult(m.momentum) + ' is the 7-day TVL trend clamped to 0.55x&ndash;2.5x' +
      (r.change_7d === null ? ' (unreported, so neutral)' : '') + '; loyalty ' + fmtMult(m.loyalty) + ' is retention credit for ' +
      (m.days_tracked === null ? 'an unknown tracking age' : m.days_tracked + ' days of TVL held with no token') + '.</div></div>' +
      '<div class="d-farm"><h3>farm plan &mdash; ' + r.farm_steps.length + ' steps</h3><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol></div>';
    drawer.classList.remove('closed');
    veil.classList.remove('closed');
    render();
  }

  function dcell(k, v) {
    return '<div class="d-cell"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  function closeDetail() {
    state.selected = null;
    drawer.classList.add('closed');
    veil.classList.add('closed');
    render();
  }

  document.getElementById('close').addEventListener('click', closeDetail);
  veil.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  // ---------- render ----------

  function render() {
    if (state.tab === 'radar') {
      var rows = visibleRows();
      view.innerHTML = radarTable(rows);
      view.querySelectorAll('tbody tr').forEach(function (tr) {
        tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-slug')); });
      });
      view.querySelectorAll('thead th').forEach(function (th) {
        th.addEventListener('click', function () {
          var k = th.getAttribute('data-k');
          if (state.sortKey === k) state.sortDir = -state.sortDir;
          else { state.sortKey = k; state.sortDir = k === 'rank' || k === 'name' || k === 'category' ? 1 : -1; }
          render();
        });
      });
    } else if (state.tab === 'launched') {
      view.innerHTML = launchedTable();
    } else {
      view.innerHTML = screenedTable();
    }
  }

  // ---------- events ----------

  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.tab = b.getAttribute('data-tab');
    document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value.trim();
    if (state.tab !== 'radar') { state.tab = 'radar'; syncTabs(); }
    render();
  });
  document.getElementById('category').addEventListener('change', function (e) {
    state.category = e.target.value;
    if (state.tab !== 'radar') { state.tab = 'radar'; syncTabs(); }
    render();
  });
  document.getElementById('chain').addEventListener('change', function (e) {
    state.chain = e.target.value;
    if (state.tab !== 'radar') { state.tab = 'radar'; syncTabs(); }
    render();
  });
  document.getElementById('wl').addEventListener('change', function (e) {
    state.wlOnly = e.target.checked;
    if (state.tab !== 'radar') { state.tab = 'radar'; syncTabs(); }
    render();
  });

  function syncTabs() {
    document.querySelectorAll('#tabs button').forEach(function (x) {
      x.classList.toggle('on', x.getAttribute('data-tab') === state.tab);
    });
  }

  render();
})();

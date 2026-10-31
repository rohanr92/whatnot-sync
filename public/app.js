// Whatnot ⇄ Shopify Sync — frontend (no build step)
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2));
const ago = (d) => {
  if (!d) return '—';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return new Date(d).toLocaleDateString();
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !['/login', '/setup'].includes(path)) { showLogin(); throw new Error('Login required'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Error ${res.status}`);
  return j;
}

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), type === 'bad' ? 7000 : 3500);
}

function modal(html, onMount) {
  $('#modalCard').classList.remove('wide');
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const close = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') close(); };
  $('#modalCard').querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  onMount?.($('#modalCard'), close);
  return close;
}

// ---------------- auth ----------------
let setupMode = false;
function showLogin(needsSetup = false) {
  setupMode = needsSetup;
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#loginIntro').textContent = needsSetup ? 'First time here — create the admin account.' : 'Log in to continue.';
  $('#lname').classList.toggle('hidden', !needsSetup);
  $('#loginBtn').textContent = needsSetup ? 'Create account' : 'Log in';
  $('#pw').autocomplete = needsSetup ? 'new-password' : 'current-password';
  $('#pw').placeholder = needsSetup ? 'Password (8+ characters)' : 'Password';
  $('#lemail').focus();
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  const body = { email: $('#lemail').value, password: $('#pw').value, name: $('#lname').value };
  try { await api(setupMode ? '/setup' : '/login', { method: 'POST', body }); $('#login').classList.add('hidden'); $('#pw').value = ''; boot(); }
  catch (err) { $('#loginErr').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };

// ---------------- state & router ----------------
let status = null;
const inv = { search: '', filter: 'all', page: 1, limit: 50, sort: 'product', rows: [], total: 0, sel: new Set(), selProducts: new Map() };

async function refreshStatus() {
  status = await api('/status');
  const s = status.settings;
  $('#locBadge').innerHTML = s.location_name ? `Syncing from<b>${esc(s.location_name)}</b>` : '<b>No location selected</b>';
  return status;
}

const views = { dash, products, inventory, import: importPage, orders, settings, logs };
async function route() {
  const v = (location.hash.replace('#/', '') || 'dash').split('?')[0] || 'dash';
  const name = views[v] ? v : 'dash';
  $('#modal').classList.add('hidden');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === name));
  try { await views[name](); } catch (e) { if (e.message !== 'Login required') $('#main').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.user) return showLogin(me.needsSetup);
  $('#userBadge').innerHTML = `Signed in as<b>${esc(me.user.name || me.user.email)}</b>`;
  $('#app').classList.remove('hidden');
  await refreshStatus();
  if (!status.settings.location_id && !location.hash) location.hash = '#/settings';
  route();
}

// poll running jobs
let jobTimer = null;
function watchJob(name, onDone) {
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    const jobs = await api('/jobs').catch(() => ({}));
    const j = jobs[name];
    const el = $('#jobProgress');
    if (el) el.innerHTML = j?.running ? `<span class="spin"></span> ${esc(j.progress || 'Working…')}` : '';
    if (j && !j.running) {
      clearInterval(jobTimer);
      if (j.error) toast(`Sync failed: ${j.error}`, 'bad');
      else toast(`Sync done — matched ${j.result?.link?.matched ?? 0}, pushed ${j.result?.push?.pushed ?? 0}`, 'ok');
      onDone?.();
    }
  }, 1500);
}
async function startFullSync(onDone) {
  try { await api('/sync/full', { method: 'POST' }); toast('Full sync started'); watchJob('sync', onDone); }
  catch (e) { toast(e.message, 'bad'); }
}

// ---------------- dashboard ----------------
async function dash() {
  await refreshStatus();
  const c = status.counts, s = status.settings, env = status.env;
  const running = status.jobs?.sync?.running;
  const setupMissing = [
    !env.shopify && 'Shopify credentials (SHOPIFY_SHOP + token)', !env.whatnot && 'WHATNOT_API_KEY',
    !s.location_id && 'Shopify location (Settings)', !env.whatnot_webhook_secret && 'WHATNOT_WEBHOOK_SECRET (for instant order sync)',
  ].filter(Boolean);
  $('#main').innerHTML = `
    <div class="page-head"><h1>Dashboard</h1><span class="sp"></span>
      <span id="jobProgress" class="progress"></span>
      <button class="btn primary" id="fullSync" ${running ? 'disabled' : ''}>↻ Full sync now</button></div>
    ${setupMissing.length ? `<div class="card" style="border-color:#f3c98b;background:#fffaf1;margin-bottom:14px">
      <b>Finish setup:</b> ${setupMissing.map(esc).join(' · ')} — <a href="#/settings">open Settings</a></div>` : ''}
    <div class="grid g4">
      <div class="card stat"><div class="n">${c.wn_variants}</div><div class="l">Whatnot variants</div></div>
      <div class="card stat"><div class="n">${c.linked}</div><div class="l">Matched to Shopify</div></div>
      <div class="card stat ${c.out_of_sync ? 'bad' : ''}"><div class="n">${c.out_of_sync}</div><div class="l">Quantity out of sync</div></div>
      <div class="card stat ${c.order_errors ? 'bad' : ''}"><div class="n">${c.orders_24h}</div><div class="l">Orders imported (24h)${c.order_errors ? ` · <b>${c.order_errors} errors</b>` : ''}</div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card stack">
        <h2>How it syncs</h2>
        <div>📦 <b>Inventory source:</b> ${s.location_name ? `<span class="b acc">${esc(s.location_name)}</span> only` : '<span class="b bad">not set</span>'}${Number(s.buffer) ? ` · buffer ${s.buffer}` : ''}</div>
        <div>⚡ <b>Shopify → Whatnot:</b> ${s.push_enabled ? '<span class="b ok">instant (webhooks)</span>' : '<span class="b">paused</span>'}</div>
        <div>🧾 <b>Whatnot orders → Shopify:</b> ${{ off: '<span class="b">off</span>', create_order: '<span class="b ok">create order + deduct stock</span>', deduct_only: '<span class="b warn">deduct stock only</span>' }[s.orders_mode]}</div>
        <div>🔁 <b>Safety re-check:</b> every ${s.reconcile_minutes} min</div>
        <div>🔗 <b>Matching:</b> ${{ sku: 'SKU', barcode: 'Whatnot SKU = Shopify barcode/UPC', both: 'SKU, then barcode/UPC' }[s.match_by]}</div>
      </div>
      <div class="card"><h2>Recent activity</h2><div id="dashLogs" class="muted">Loading…</div>
        <a href="#/logs">All activity →</a></div>
    </div>`;
  $('#fullSync').onclick = () => { $('#fullSync').disabled = true; startFullSync(dash); };
  if (running) watchJob('sync', dash);
  const lg = await api('/logs');
  $('#dashLogs').innerHTML = lg.slice(0, 8).map((l) => `<div style="padding:5px 0;border-bottom:1px dashed var(--line)">
    <span class="b ${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : ''}">${esc(l.area)}</span> ${esc(l.message)} <span class="muted">· ${ago(l.created_at)}</span></div>`).join('') || 'No activity yet.';
}

// ---------------- inventory ----------------
const FILTERS = [['all', 'All'], ['diff', 'Out of sync'], ['matched', 'Matched'], ['unmatched', 'Not matched'], ['notstocked', 'Not stocked at location'], ['noprice', 'No price']];

async function inventory() {
  await refreshStatus();
  $('#main').innerHTML = `
    <div class="page-head"><h1>Inventory & prices</h1><span class="sp"></span>
      <span id="jobProgress" class="progress"></span>
      <button class="btn" id="pushAll">⇡ Push inventory</button>
      <button class="btn primary" id="fullSync">↻ Refresh both sides</button></div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search product, size, SKU…" value="${esc(inv.search)}" />
      <select id="sort" style="width:auto">
        <option value="product">Sort: product</option><option value="sku">Sort: SKU</option>
        <option value="qty">Sort: qty</option><option value="price">Sort: price</option></select>
    </div>
    <div class="chips" id="chips">${FILTERS.map(([k, l]) => `<button class="chip ${inv.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div style="height:10px"></div>
    <div id="bulk"></div>
    <div id="tbl"></div>
    <div class="pager" id="pager"></div>`;
  $('#sort').value = inv.sort;
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { inv.search = e.target.value; inv.page = 1; loadInv(); }, 300); };
  $('#sort').onchange = (e) => { inv.sort = e.target.value; loadInv(); };
  $('#chips').onclick = (e) => { const f = e.target.dataset.f; if (!f) return; inv.filter = f; inv.page = 1; clearSel(); inventory(); };
  $('#fullSync').onclick = () => startFullSync(loadInv);
  $('#pushAll').onclick = async () => {
    try { const r = await api('/sync/push', { method: 'POST', body: {} }); toast(`Checked ${r.checked}, updated ${r.pushed} on Whatnot`, 'ok'); loadInv(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  if (status.jobs?.sync?.running) watchJob('sync', loadInv);
  loadInv();
}

function clearSel() { inv.sel.clear(); inv.selProducts.clear(); }

async function loadInv() {
  const qs = new URLSearchParams({ search: inv.search, filter: inv.filter, page: inv.page, limit: inv.limit, sort: inv.sort });
  const r = await api('/variants?' + qs);
  inv.rows = r.rows; inv.total = r.total;
  renderInv(); renderBulk();
}

function qtyCell(r) {
  if (!r.shop_id) return '<span class="b">—</span>';
  const loc = r.stocked ? r.shop_qty : '<span class="b warn" title="Not stocked at this location">not stocked</span>';
  const diff = r.wn_qty !== r.target_qty;
  return `<span class="qwrap"><span class="qty">${loc}</span><span class="arrow">→</span><span class="qty">${r.wn_qty ?? '?'}</span>${diff ? ` <span class="b bad" title="Whatnot should be ${r.target_qty}">≠ ${r.target_qty}</span>` : ''}</span>`;
}

function renderInv() {
  const rows = inv.rows;
  if (!rows.length) {
    $('#tbl').innerHTML = `<div class="card empty">${inv.total === 0 && inv.filter === 'all' && !inv.search
      ? 'No Whatnot products loaded yet. Pick your location in Settings, then click <b>Refresh both sides</b>.' : 'Nothing matches this filter.'}</div>`;
    $('#pager').innerHTML = ''; return;
  }
  const allOnPage = rows.every((r) => inv.sel.has(r.id));
  $('#tbl').innerHTML = `<div class="tbl-wrap cards"><table>
    <thead><tr><th style="width:36px"><input type="checkbox" id="selPage" ${allOnPage ? 'checked' : ''} /></th>
      <th>Whatnot product</th><th>SKU</th><th>Shopify match</th><th class="num">Location → Whatnot</th>
      <th class="num">Buy it now $</th><th class="num">Auction start $</th><th>Format</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}">
      <td class="c-sel"><input type="checkbox" class="sel" ${inv.sel.has(r.id) ? 'checked' : ''} /></td>
      <td class="c-prod"><div class="prod">${r.image ? `<img class="thumb" src="${esc(r.image)}" loading="lazy" alt="" />` : '<div class="thumb"></div>'}
        <div><div class="t">${esc(r.product_title)}</div><div class="o">${esc(r.options || '')}</div></div></div></td>
      <td data-l="SKU" class="mono">${esc(r.sku || '—')}</td>
      <td data-l="Shopify">${r.shop_id ? `<span class="mono">${esc(r.shop_sku || r.shop_barcode || '')}</span> <span class="b ${r.manual ? 'acc' : 'ok'}">${esc(r.match_type)}</span>`
        : '<button class="btn sm link-btn2" data-act="link">Link SKU</button>'}</td>
      <td data-l="Location → Whatnot" class="num">${qtyCell(r)}</td>
      <td data-l="Buy it now" class="num"><input class="price-in" data-f="bin_price" inputmode="decimal" value="${fmt$(r.bin_price)}" placeholder="—" /></td>
      <td data-l="Auction start" class="num"><input class="price-in" data-f="auction_price" inputmode="decimal" value="${fmt$(r.auction_price)}" placeholder="—" /></td>
      <td data-l="Format">${r.transaction_type ? `<span class="b">${r.transaction_type === 'buy_it_now' ? 'Buy it now' : 'Auction'}${r.reserved_for_live ? ' · live' : ''}</span>` : '<span class="muted">—</span>'}</td>
      <td data-l=""><button class="btn sm" data-act="edit">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;

  const pages = Math.max(1, Math.ceil(inv.total / inv.limit));
  $('#pager').innerHTML = `<span class="muted">${inv.total} variants</span>
    <button class="btn sm" id="prev" ${inv.page <= 1 ? 'disabled' : ''}>‹</button>
    <span>${inv.page} / ${pages}</span>
    <button class="btn sm" id="next" ${inv.page >= pages ? 'disabled' : ''}>›</button>
    <select id="lim" style="width:auto">${[25, 50, 100, 250].map((n) => `<option ${n === inv.limit ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  $('#prev').onclick = () => { inv.page--; loadInv(); };
  $('#next').onclick = () => { inv.page++; loadInv(); };
  $('#lim').onchange = (e) => { inv.limit = Number(e.target.value); inv.page = 1; loadInv(); };

  $('#selPage').onchange = (e) => {
    rows.forEach((r) => { if (e.target.checked) { inv.sel.add(r.id); inv.selProducts.set(r.id, r.product_id); } else { inv.sel.delete(r.id); inv.selProducts.delete(r.id); } });
    renderInv(); renderBulk();
  };
  const tbody = $('#tbl tbody');
  tbody.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr'); const id = tr?.dataset.id; if (!id) return;
    const row = rows.find((r) => r.id === id);
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) { inv.sel.add(id); inv.selProducts.set(id, row.product_id); } else { inv.sel.delete(id); inv.selProducts.delete(id); }
      renderBulk(); return;
    }
    if (e.target.classList.contains('price-in')) {
      const f = e.target.dataset.f, val = e.target.value.trim();
      if (val === fmt$(row[f])) return;
      if (val !== '' && !(Number(val) > 0)) { toast('Enter a price above 0', 'bad'); e.target.value = fmt$(row[f]); return; }
      if (val === '') { toast('A price can be changed but not removed', 'bad'); e.target.value = fmt$(row[f]); return; }
      e.target.classList.add('saving');
      try {
        await api(`/variants/${id}`, { method: 'PATCH', body: { [f]: val } });
        row[f] = val; e.target.classList.remove('saving'); e.target.classList.add('saved'); e.target.value = fmt$(val);
        setTimeout(() => e.target.classList.remove('saved'), 1500);
      } catch (err) { e.target.classList.remove('saving'); e.target.value = fmt$(row[f]); toast(err.message, 'bad'); }
    }
  });
  tbody.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('price-in')) e.target.blur(); });
  tbody.addEventListener('click', (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const row = rows.find((r) => r.id === e.target.closest('tr').dataset.id);
    editVariant(row, act === 'link');
  });
}

function renderBulk() {
  const n = inv.sel.size;
  if (!n) { $('#bulk').innerHTML = inv.total > inv.rows.length || inv.total > 0
    ? `<div class="row" style="margin-bottom:10px"><button class="btn sm" id="selAll">Select all ${inv.total} matching</button></div>` : '';
    const sa = $('#selAll'); if (sa) sa.onclick = selectAllMatching; return; }
  $('#bulk').innerHTML = `<div class="bulkbar"><b>${n} selected</b>
    ${n < inv.total ? `<button class="btn sm" id="selAll">Select all ${inv.total}</button>` : ''}
    <span class="sp"></span>
    <button class="btn sm" id="bPrice">$ Edit prices</button>
    <button class="btn sm" id="bFormat">Sale format</button>
    <button class="btn sm" id="bPush">⇡ Push inventory</button>
    <button class="btn sm" id="bClear">✕</button></div>`;
  const sa = $('#selAll'); if (sa) sa.onclick = selectAllMatching;
  $('#bClear').onclick = () => { clearSel(); renderInv(); renderBulk(); };
  $('#bPrice').onclick = bulkPriceModal;
  $('#bFormat').onclick = bulkFormatModal;
  $('#bPush').onclick = async () => {
    try { const r = await api('/sync/push', { method: 'POST', body: { ids: [...inv.sel], force: true } }); toast(`Pushed ${r.pushed} of ${r.checked} matched variants`, 'ok'); loadInv(); }
    catch (e) { toast(e.message, 'bad'); }
  };
}

async function selectAllMatching() {
  const r = await api('/variants/ids?' + new URLSearchParams({ search: inv.search, filter: inv.filter }));
  r.items.forEach(([id, pid]) => { inv.sel.add(id); inv.selProducts.set(id, pid); });
  renderInv(); renderBulk();
}

const PRICE_MODES = [
  ['set', 'Set to exact price', true], ['inc_pct', 'Increase by %', true], ['dec_pct', 'Decrease by %', true],
  ['inc_amt', 'Increase by $', true], ['dec_amt', 'Decrease by $', true],
  ['shopify', 'Copy Shopify price', false], ['shopify_pct', 'Shopify price ± %', true],
  ['copy_bin', 'Copy Buy-it-now price (auction only)', false], ['copy_bin_pct', 'Buy-it-now price ± % (auction only)', true],
];

function bulkPriceModal() {
  const ids = [...inv.sel];
  modal(`<h2>Edit prices · ${ids.length} variants</h2>
    <label class="f"><span>Which price</span><select id="pf"><option value="bin">Buy it now price</option><option value="auction">Auction starting price</option></select></label>
    <label class="f"><span>Change</span><select id="pm">${PRICE_MODES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    <label class="f" id="pvWrap"><span>Value</span><input type="number" id="pv" step="0.01" placeholder="e.g. 49 or 10" /></label>
    <label class="f"><span>Rounding</span><select id="pr">
      <option value="none">Exact (2 decimals)</option><option value="99">End in .99</option><option value="whole">Whole dollars</option></select></label>
    <div class="muted" style="font-size:13px">Preview (first 5):</div><div class="preview" id="pp">—</div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pa">Apply to ${ids.length}</button></div>`,
  (el, close) => {
    $('#pr', el).value = status.settings.rounding || 'none';
    const sync = async () => {
      const m = PRICE_MODES.find((x) => x[0] === $('#pm', el).value);
      $('#pvWrap', el).style.display = m[2] ? '' : 'none';
      const body = { ids: ids.slice(0, 5), field: $('#pf', el).value, mode: m[0], value: $('#pv', el).value, rounding: $('#pr', el).value };
      try {
        const p = await api('/variants/preview-price', { method: 'POST', body });
        $('#pp', el).innerHTML = p.map((r) => `<div><span>${esc(r.product_title)} <span class="muted">${esc(r.options || '')}</span></span>
          <span>${fmt$(body.field === 'bin' ? r.bin_price : r.auction_price) || '—'} → <b>${r.new_price > 0 ? fmt$(r.new_price) : 'skip'}</b></span></div>`).join('') || '—';
      } catch { /* ignore */ }
    };
    ['#pf', '#pm', '#pv', '#pr'].forEach((s) => $(s, el).addEventListener('input', sync));
    sync();
    $('#pa', el).onclick = async () => {
      $('#pa', el).disabled = true; $('#pa', el).innerHTML = '<span class="spin"></span> Updating…';
      try {
        const r = await api('/variants/bulk-price', { method: 'POST', body: { ids, field: $('#pf', el).value, mode: $('#pm', el).value, value: $('#pv', el).value, rounding: $('#pr', el).value } });
        toast(`Updated ${r.updated} prices${r.skipped ? `, skipped ${r.skipped}` : ''}${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length ? 'bad' : 'ok');
        if (r.errors.length) console.warn(r.errors);
        close(); loadInv();
      } catch (e) { toast(e.message, 'bad'); $('#pa', el).disabled = false; $('#pa', el).textContent = 'Apply'; }
    };
  });
}

function bulkFormatModal() {
  const productIds = [...new Set(inv.selProducts.values())];
  modal(`<h2>Sale format · ${productIds.length} products</h2>
    <p class="muted">Sale format applies to the whole Whatnot product (all its sizes).</p>
    <label class="f"><span>Sell as</span><select id="tt"><option value="">Don't change</option><option value="buy_it_now">Buy it now</option><option value="auction">Auction (live shows only)</option></select></label>
    <label class="f"><span>Reserve for live</span><select id="rl"><option value="">Don't change</option><option value="false">No — show in profile shop</option><option value="true">Yes — only during shows</option></select>
      <small>To publish, each variant needs a price and stock, plus a description, image and required category details.</small></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="fa">Apply</button></div>`,
  (el, close) => {
    $('#fa', el).onclick = async () => {
      const tt = $('#tt', el).value, rl = $('#rl', el).value;
      if (!tt && !rl) return toast('Choose something to change', 'bad');
      if (tt === 'auction' && rl === 'false') return toast('Auctions are always reserved for live', 'bad');
      $('#fa', el).disabled = true; $('#fa', el).innerHTML = '<span class="spin"></span> Updating…';
      try {
        const r = await api('/products/merch', { method: 'POST', body: { product_ids: productIds, transaction_type: tt || undefined, reserve_for_live: rl ? rl === 'true' : undefined } });
        toast(`Updated ${r.updated} products${r.errors.length ? ` — ${r.errors.length} errors (see Activity)` : ''}`, r.errors.length ? 'bad' : 'ok');
        close(); if (location.hash.includes('products')) loadProducts(); else loadInv();
      } catch (e) { toast(e.message, 'bad'); $('#fa', el).disabled = false; $('#fa', el).textContent = 'Apply'; }
    };
  });
}

function editVariant(r, focusLink) {
  modal(`<h2>${esc(r.product_title)}</h2><p class="muted" style="margin-top:-6px">${esc(r.options || '')} · Whatnot SKU <span class="mono">${esc(r.sku || '—')}</span></p>
    <div class="grid g2">
      <label class="f"><span>Buy it now price</span><input type="number" step="0.01" id="eb" value="${fmt$(r.bin_price)}" /></label>
      <label class="f"><span>Auction starting price</span><input type="number" step="0.01" id="ea" value="${fmt$(r.auction_price)}" /></label>
    </div>
    <label class="f"><span>Linked Shopify variant (SKU, barcode/UPC or variant ID)</span>
      <input type="text" id="el" value="${esc(r.manual ? r.shop_sku || '' : '')}" placeholder="${esc(r.shop_sku ? `Auto: ${r.shop_sku}` : 'Type a Shopify SKU')}" />
      <small>${r.shop_id ? `Now: ${esc(r.shop_product)} · ${esc(r.shop_title)} (${esc(r.match_type)}). Leave blank to keep automatic matching.` : 'Not matched yet. Enter the Shopify SKU to link it manually.'}</small></label>
    ${r.shop_id ? `<div class="preview"><div><span>At location</span><b>${r.stocked ? r.shop_qty : 'not stocked'}</b></div><div><span>On Whatnot</span><b>${r.wn_qty ?? '?'}</b></div><div><span>Shopify price</span><b>${fmt$(r.shop_price)}</b></div></div>` : ''}
    <div class="modal-foot">${r.manual ? '<button class="btn danger" id="unlink">Remove manual link</button>' : ''}
      ${r.wn_url ? `<a class="btn" href="${esc(r.wn_url)}" target="_blank" rel="noopener">Open on Whatnot</a>` : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="es">Save</button></div>`,
  (el, close) => {
    if (focusLink) $('#el', el).focus();
    const un = $('#unlink', el);
    if (un) un.onclick = async () => { try { await api(`/variants/${r.id}`, { method: 'PATCH', body: { link: '' } }); toast('Manual link removed', 'ok'); close(); loadInv(); } catch (e) { toast(e.message, 'bad'); } };
    $('#es', el).onclick = async () => {
      const body = {};
      const b = $('#eb', el).value, a = $('#ea', el).value, l = $('#el', el).value.trim();
      if (b !== fmt$(r.bin_price) && b !== '') body.bin_price = b;
      if (a !== fmt$(r.auction_price) && a !== '') body.auction_price = a;
      if (l && l !== (r.manual ? r.shop_sku : '')) body.link = l;
      if (!Object.keys(body).length) return close();
      $('#es', el).disabled = true;
      try { await api(`/variants/${r.id}`, { method: 'PATCH', body }); toast('Saved', 'ok'); close(); loadInv(); }
      catch (e) { toast(e.message, 'bad'); $('#es', el).disabled = false; }
    };
  });
}

// ---------------- orders ----------------
const ORDER_BADGE = { imported: 'ok', deducted: 'ok', cancelled: '', skipped: '', processing: 'warn', order_created: 'warn', error: 'bad' };
async function orders() {
  $('#main').innerHTML = `<div class="page-head"><h1>Whatnot orders</h1><span class="sp"></span>
    <button class="btn" id="pollO">⇣ Check for new orders</button></div><div id="otbl" class="muted">Loading…</div>`;
  $('#pollO').onclick = async () => { try { const r = await api('/sync/orders', { method: 'POST' }); toast(`Checked ${r.checked}, imported ${r.imported ?? 0}`, 'ok'); orders(); } catch (e) { toast(e.message, 'bad'); } };
  const rows = await api('/orders');
  if (!rows.length) { $('#otbl').innerHTML = '<div class="card empty">No Whatnot orders imported yet. New orders arrive here instantly once the Whatnot webhook is set up.</div>'; return; }
  $('#otbl').innerHTML = `<div class="tbl-wrap cards"><table><thead><tr><th>Whatnot order</th><th>Date</th><th>Buyer</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Shopify</th><th>Tracking</th><th></th></tr></thead>
    <tbody>${rows.map((o) => `<tr>
      <td class="c-prod"><b class="mono">#${esc(o.wn_order_id)}</b></td>
      <td data-l="Date">${o.wn_created_at ? new Date(o.wn_created_at).toLocaleString() : '—'}</td>
      <td data-l="Buyer">${o.buyer ? '@' + esc(o.buyer) : '—'}</td>
      <td data-l="Items"><div>${(o.items || []).map((i) => `<div style="white-space:nowrap">${i.quantity}× <span class="mono">${esc(i.sku || i.title)}</span>${i.shop_variant_id ? '' : ' <span class="b warn">no match</span>'}</div>`).join('') || '—'}</div></td>
      <td data-l="Total" class="num">${esc(o.total || '')}</td>
      <td data-l="Status"><div><span class="b ${ORDER_BADGE[o.status] || ''}" title="${esc(o.error || '')}">${esc(o.status)}</span>${o.error ? `<div class="muted" style="font-size:12px;max-width:260px">${esc(o.error)}</div>` : ''}</div></td>
      <td data-l="Shopify">${esc(o.shopify_order_name || '—')}</td>
      <td data-l="Tracking"><div>${Object.values(o.tracking || {}).map((t) => `<div class="mono" style="white-space:nowrap">${esc(t.carrier.toUpperCase())} ${esc(t.tracking_code)} <span class="b ok">sent</span></div>`).join('')}
        ${o.tracking_status === 'error' ? `<div class="b bad" title="${esc(o.tracking_error)}">failed</div><div class="muted" style="font-size:12px;max-width:240px">${esc(o.tracking_error)}</div>` : ''}
        ${!o.tracking && o.tracking_status !== 'error' ? '<span class="muted">—</span>' : ''}</div></td>
      <td data-l=""><div class="row" style="justify-content:flex-end">${['error', 'processing', 'order_created', 'skipped'].includes(o.status) ? `<button class="btn sm" data-retry="${esc(o.wn_order_id)}">Retry</button>` : ''}
        ${o.status !== 'cancelled' ? `<button class="btn sm" data-track="${esc(o.wn_order_id)}">+ Tracking</button>` : ''}</div></td>
    </tr>`).join('')}</tbody></table></div>`;
  $('#otbl').onclick = async (e) => {
    if (e.target.dataset.track) return trackingModal(e.target.dataset.track);
    const id = e.target.dataset.retry; if (!id) return;
    e.target.disabled = true;
    try { const r = await api(`/orders/${id}/retry`, { method: 'POST' }); toast(r.skipped || `Imported ${r.shopify_order || ''}`, 'ok'); orders(); }
    catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
  };
}

function trackingModal(orderId) {
  modal(`<h2>Send tracking · Whatnot #${esc(orderId)}</h2>
    <p class="muted">Tracking is sent automatically when you fulfill the Shopify order with a tracking number. Use this to send it by hand.</p>
    <label class="f"><span>Carrier</span><select id="tc"><option value="usps">USPS</option><option value="ups">UPS</option><option value="fedex">FedEx</option><option value="dhl">DHL</option></select></label>
    <label class="f"><span>Tracking number</span><input type="text" id="tn" autocomplete="off" /></label>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ts">Send to Whatnot</button></div>`,
  (el, close) => {
    $('#tn', el).focus();
    $('#ts', el).onclick = async () => {
      $('#ts', el).disabled = true;
      try { const r = await api(`/orders/${orderId}/tracking`, { method: 'POST', body: { carrier: $('#tc', el).value, tracking_code: $('#tn', el).value } }); toast(r.skipped || 'Tracking sent to Whatnot', 'ok'); close(); orders(); }
      catch (e) { toast(e.message, 'bad'); $('#ts', el).disabled = false; }
    };
  });
}

// ---------------- settings ----------------
async function settings() {
  await refreshStatus();
  const s = status.settings, env = status.env, me = status.user || {};
  const dims = s.default_dims || {};
  const ck = (ok, label, hint = '') => `<li><span class="b ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span><div>${label}${hint && !ok ? `<div class="muted" style="font-size:12px">${hint}</div>` : ''}</div></li>`;
  $('#main').innerHTML = `<div class="page-head"><h1>Settings</h1><span class="sp"></span><button class="btn" id="testBtn">Test connections</button>
    <button class="btn primary" id="save">Save settings</button></div>
  <div class="grid g2">
    <div class="card">
      <h2>1 · Inventory source</h2>
      <label class="f"><span>Shopify location to send to Whatnot</span><select id="loc"><option value="">Loading locations…</option></select>
        <small>Only this location's "available" stock goes to Whatnot. Other locations are ignored.</small></label>
      <label class="f"><span>Safety buffer (units)</span><input type="number" id="buf" min="0" value="${esc(s.buffer)}" />
        <small>Whatnot shows location stock minus this number. 0 = exact.</small></label>
      <label class="f"><span>Match products by</span><select id="mb">
        <option value="sku">SKU (Whatnot SKU = Shopify SKU)</option><option value="barcode">UPC/barcode (Whatnot SKU = Shopify barcode)</option>
        <option value="both">SKU first, then UPC/barcode</option></select>
        <small>Listings made by this app or the Shopify channel also match by Shopify variant ID.</small></label>
      <label class="switch"><input type="checkbox" id="push" ${s.push_enabled ? 'checked' : ''} /> Instantly push stock changes to Whatnot</label>
      <label class="switch"><input type="checkbox" id="zu" ${s.zero_unmatched ? 'checked' : ''} /> Set unmatched Whatnot variants to 0</label>
    </div>
    <div class="card">
      <h2>2 · Orders & tracking</h2>
      <label class="f"><span>When a Whatnot order comes in</span><select id="om">
        <option value="create_order">Create a Shopify order + deduct stock at the location</option>
        <option value="deduct_only">Only deduct stock at the location (no Shopify order)</option>
        <option value="off">Do nothing</option></select>
        <small>Only orders after ${s.orders_since ? `<b>${new Date(s.orders_since).toLocaleString()}</b>` : 'the moment you turn this on'} are imported.</small></label>
      <label class="switch"><input type="checkbox" id="trk" ${s.tracking_enabled ? 'checked' : ''} /> When I fulfill in Shopify, send the tracking number to Whatnot</label>
      <p class="muted" style="margin:-6px 0 12px;font-size:12.5px">Needs the Whatnot token to have <span class="mono">write:shipments</span> and your account to be allowed to use your own shipping labels.</p>
      <label class="f"><span>Full re-check every (minutes)</span><input type="number" id="rm" min="5" value="${esc(s.reconcile_minutes)}" /></label>
      <label class="f"><span>Default price rounding</span><select id="rd"><option value="none">Exact</option><option value="99">End in .99</option><option value="whole">Whole dollars</option></select></label>
    </div>
    <div class="card">
      <h2>3 · New listings from Shopify</h2>
      <label class="f"><span>Default Whatnot category</span>${catPicker('defcat', s.default_category_id)}
        <small>Used when the app can't guess one. Your choices per Shopify product type are remembered automatically.</small></label>
      <div class="grid g2" style="gap:0 12px">
        <label class="f"><span>Price from Shopify</span><select id="ps"><option value="price">Price</option><option value="compare_at">Compare-at price</option></select></label>
        <label class="f"><span>Buy-it-now markup %</span><input type="number" id="mk" value="${esc(s.price_markup_pct)}" /></label>
        <label class="f"><span>Auction start (% of BIN)</span><input type="number" id="ap" placeholder="blank = none" value="${esc(s.auction_start_pct ?? '')}" /></label>
        <label class="f"><span>Sell as</span><select id="sf"><option value="buy_it_now">Buy it now</option><option value="auction">Auction</option></select></label>
        <label class="f"><span>Condition</span><input type="text" id="cond" value="${esc(s.default_condition)}" /></label>
        <label class="f"><span>Shipping box (Whatnot profile)</span><select id="dp"><option value="">Custom size below</option></select></label>
      </div>
      <div class="grid g2" style="gap:0 12px" id="dimsBox">
        <label class="f"><span>Box L × W × H (inch)</span><div class="row" style="flex-wrap:nowrap"><input type="number" id="dl" value="${esc(dims.length)}" /><input type="number" id="dw" value="${esc(dims.width)}" /><input type="number" id="dh" value="${esc(dims.height)}" /></div></label>
        <label class="f"><span>Weight (oz)</span><input type="number" id="dwt" value="${esc(dims.weight)}" /></label>
      </div>
      <label class="switch"><input type="checkbox" id="pub" ${s.auto_publish ? 'checked' : ''} /> Publish to my Whatnot shop right after creating</label>
    </div>
    <div class="card">
      <h2>4 · Webhooks (instant sync)</h2>
      <p class="muted">Shopify: click below once after deploying (and again after any update). Whatnot: paste this URL in the
        <a href="https://www.whatnot.com/dashboard/developer" target="_blank" rel="noopener">Whatnot developer dashboard</a> → Webhooks and subscribe to
        <span class="mono">orders.created</span>, <span class="mono">orders.updated</span>, <span class="mono">products.created</span>, <span class="mono">products.updated</span>, <span class="mono">products.deleted</span>.</p>
      <label class="f"><span>Whatnot webhook URL</span><div class="copy"><input type="text" readonly id="wurl" value="${esc(status.app_url)}/webhooks/whatnot" /><button class="btn" id="cp">Copy</button></div></label>
      <button class="btn" id="regWh">Register Shopify webhooks</button>
      <div id="whRes" class="muted" style="margin-top:8px;font-size:13px"></div>
      <h2 style="margin-top:18px">Environment check</h2>
      <ul class="check-list">
        ${ck(env.shopify, 'Shopify API credentials', 'Set SHOPIFY_SHOP and SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ACCESS_TOKEN)')}
        ${ck(env.shopify_webhook_secret, 'Shopify webhook secret', 'Set SHOPIFY_CLIENT_SECRET (or SHOPIFY_API_SECRET) so webhooks can be verified')}
        ${ck(env.whatnot, 'Whatnot API key', 'Set WHATNOT_API_KEY')}
        ${ck(env.whatnot_webhook_secret, 'Whatnot webhook secret', 'Set WHATNOT_WEBHOOK_SECRET (wn_wh_…) from the developer dashboard')}
      </ul>
      <div id="testRes" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <h2>Your account</h2>
      <p class="muted">${esc(me.email || '')} · ${esc(me.role || '')}</p>
      <div class="grid g2" style="gap:0 12px">
        <label class="f"><span>Current password</span><input type="password" id="cpw" autocomplete="current-password" /></label>
        <label class="f"><span>New password</span><input type="password" id="npw" autocomplete="new-password" /></label>
      </div>
      <button class="btn" id="chpw">Change password</button>
    </div>
    ${me.role === 'admin' ? `<div class="card"><h2>Team</h2><div id="team" class="muted">Loading…</div>
      <div class="grid g2" style="gap:0 12px;margin-top:12px">
        <label class="f"><span>Email</span><input type="email" id="uem" /></label>
        <label class="f"><span>Name</span><input type="text" id="unm" /></label>
        <label class="f"><span>Temporary password</span><input type="text" id="upw" autocomplete="off" /></label>
        <label class="f"><span>Role</span><select id="url"><option value="staff">Staff</option><option value="admin">Admin</option></select></label>
      </div><button class="btn" id="addUser">Add user</button></div>` : ''}
  </div>`;
  $('#mb').value = s.match_by; $('#om').value = s.orders_mode; $('#rd').value = s.rounding || 'none';
  $('#ps').value = s.price_source || 'price'; $('#sf').value = s.default_sale_format || 'buy_it_now';
  mountCatPicker('defcat');
  api('/locations').then((locs) => {
    $('#loc').innerHTML = '<option value="">— choose a location —</option>' + locs.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}${l.address?.city ? ' · ' + esc(l.address.city) : ''}</option>`).join('');
    $('#loc').value = s.location_id || '';
  }).catch((e) => { $('#loc').innerHTML = `<option value="">Can't load: ${esc(e.message)}</option>`; });
  api('/dimension-profiles').then((dps) => {
    $('#dp').innerHTML = '<option value="">Custom size below</option>' + dps.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${d.dimensions?.length}×${d.dimensions?.width}×${d.dimensions?.height} ${esc(d.dimensions?.unit || '')}, ${d.weight?.value} ${esc(d.weight?.unit || '')})</option>`).join('');
    $('#dp').value = s.dimension_profile_id || '';
  }).catch(() => {});
  const loadTeam = async () => {
    if (!$('#team')) return;
    const us = await api('/users');
    $('#team').innerHTML = us.map((u) => `<div class="row" style="padding:6px 0;border-bottom:1px dashed var(--line)"><b>${esc(u.name || '')}</b>
      <span class="mono">${esc(u.email)}</span><span class="b ${u.role === 'admin' ? 'acc' : ''}">${esc(u.role)}</span><span class="sp" style="flex:1"></span>
      ${String(u.id) !== String(me.id) ? `<button class="btn sm danger" data-del="${u.id}">Remove</button>` : '<span class="muted">you</span>'}</div>`).join('');
  };
  loadTeam();
  if ($('#team')) {
    $('#team').onclick = async (e) => {
      const id = e.target.dataset.del; if (!id || !confirmBox('Remove this user?')) return;
      try { await api(`/users/${id}`, { method: 'DELETE' }); loadTeam(); } catch (err) { toast(err.message, 'bad'); }
    };
    $('#addUser').onclick = async () => {
      try { await api('/users', { method: 'POST', body: { email: $('#uem').value, name: $('#unm').value, password: $('#upw').value, role: $('#url').value } });
        toast('User added — share the email and temporary password with them', 'ok'); ['#uem', '#unm', '#upw'].forEach((x) => ($(x).value = '')); loadTeam(); }
      catch (err) { toast(err.message, 'bad'); }
    };
  }
  $('#chpw').onclick = async () => {
    try { await api('/me/password', { method: 'POST', body: { current: $('#cpw').value, password: $('#npw').value } }); toast('Password changed', 'ok'); $('#cpw').value = ''; $('#npw').value = ''; }
    catch (e) { toast(e.message, 'bad'); }
  };
  $('#cp').onclick = () => { navigator.clipboard.writeText($('#wurl').value); toast('Copied'); };
  $('#testBtn').onclick = async () => {
    $('#testRes').innerHTML = '<span class="spin"></span> Testing…';
    const r = await api('/test');
    $('#testRes').innerHTML = `<div>${r.shopify.ok ? `<span class="b ok">Shopify OK</span> ${esc(r.shopify.name)}` : `<span class="b bad">Shopify</span> ${esc(r.shopify.error)}`}</div>
      <div style="margin-top:6px">${r.whatnot.ok ? '<span class="b ok">Whatnot OK</span>' : `<span class="b bad">Whatnot</span> ${esc(r.whatnot.error)}`}</div>`;
  };
  $('#regWh').onclick = async () => {
    $('#whRes').innerHTML = '<span class="spin"></span>';
    try { const r = await api('/webhooks/register', { method: 'POST' }); $('#whRes').innerHTML = r.shopify.map((x) => `${esc(x.topic)}: <b>${esc(x.status)}</b>`).join('<br>'); }
    catch (e) { $('#whRes').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
  $('#save').onclick = async () => {
    const body = { buffer: $('#buf').value, match_by: $('#mb').value, push_enabled: $('#push').checked, orders_mode: $('#om').value,
      reconcile_minutes: $('#rm').value, rounding: $('#rd').value, zero_unmatched: $('#zu').checked, tracking_enabled: $('#trk').checked,
      default_category_id: catValue('defcat'), price_source: $('#ps').value, price_markup_pct: $('#mk').value, auction_start_pct: $('#ap').value,
      default_sale_format: $('#sf').value, default_condition: $('#cond').value, dimension_profile_id: $('#dp').value || null, auto_publish: $('#pub').checked,
      default_dims: { length: Number($('#dl').value), width: Number($('#dw').value), height: Number($('#dh').value), unit: 'inch', weight: Number($('#dwt').value), weight_unit: 'ounce' } };
    if ($('#loc').value && $('#loc').value !== s.location_id) body.location_id = $('#loc').value;
    try {
      await api('/settings', { method: 'POST', body });
      toast(body.location_id ? 'Saved — loading products from the new location…' : 'Saved', 'ok');
      await refreshStatus();
      if (body.location_id) location.hash = '#/';
    } catch (e) { toast(e.message, 'bad'); }
  };
}

function confirmBox(msg) { return window.confirm(msg); }

// ---------------- category picker (searchable) ----------------
const catState = {};
function catPicker(key, id, label = '') {
  catState[key] = { id: id || null, label };
  return `<div class="cat-pick" data-cat="${key}"><input type="text" class="cat-in" placeholder="Search Whatnot categories… e.g. women's shoes" value="${esc(label)}" autocomplete="off" />
    <div class="cat-list hidden"></div></div>`;
}
async function mountCatPicker(key, onPick, root = document) {
  const box = root.querySelector(`[data-cat="${key}"]`); if (!box) return;
  const inp = box.querySelector('.cat-in'), list = box.querySelector('.cat-list');
  if (catState[key].id && !catState[key].label) {
    try { const c = await api(`/categories/${catState[key].id}`); catState[key].label = c.path; inp.value = c.path; } catch { /* ignore */ }
  }
  let t;
  const search = async () => {
    const r = await api('/categories?search=' + encodeURIComponent(inp.value));
    list.innerHTML = r.slice(0, 60).map((c) => `<div data-id="${c.id}" data-path="${esc(c.path)}">${esc(c.path)}</div>`).join('') || '<div class="muted">No match</div>';
    list.classList.remove('hidden');
  };
  inp.onfocus = () => { inp.select(); search(); };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(search, 200); };
  inp.onblur = () => setTimeout(() => { list.classList.add('hidden'); inp.value = catState[key].label || ''; }, 200);
  list.onmousedown = (e) => {
    const d = e.target.closest('[data-id]'); if (!d) return;
    catState[key] = { id: Number(d.dataset.id), label: d.dataset.path };
    inp.value = d.dataset.path; list.classList.add('hidden');
    onPick?.(catState[key].id);
  };
}
const catValue = (key) => catState[key]?.id || null;

// attribute fields for a category: returns html; read with readAttrs(root)
function attrFields(cat, values = []) {
  if (!cat) return '<p class="muted">Pick a category to see its fields.</p>';
  const val = (id) => values.find((v) => String(v.id) === String(id))?.value ?? '';
  return `<div class="attr-grid">${cat.attributes.map((a) => {
    const v = val(a.id);
    const listId = `al-${a.id}`;
    const input = a.type === 'ENUM' && !a.custom
      ? `<select data-attr="${a.id}"><option value="">—</option>${a.values.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`
      : `<input type="text" data-attr="${a.id}" value="${esc(v)}" list="${listId}" /><datalist id="${listId}">${a.values.slice(0, 200).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
    return `<label class="f"><span>${esc(a.label)}${a.required ? ' <span class="b bad">required</span>' : ''}</span>${input}</label>`;
  }).join('')}</div>`;
}
const readAttrs = (root) => [...root.querySelectorAll('[data-attr]')].map((el) => ({ id: el.dataset.attr, value: el.value.trim() })).filter((a) => a.value);

// ---------------- logs ----------------
async function logs() {
  $('#main').innerHTML = `<div class="page-head"><h1>Activity</h1><span class="sp"></span>
    <select id="lv" style="width:auto"><option value="">All</option><option value="error">Errors</option><option value="warn">Warnings</option></select>
    <button class="btn" id="rl">Refresh</button></div><div id="ltbl"></div>`;
  const load = async () => {
    const rows = await api('/logs' + ($('#lv').value ? `?level=${$('#lv').value}` : ''));
    $('#ltbl').innerHTML = rows.length ? `<div class="tbl-wrap"><table class="log"><tbody>${rows.map((l) => `<tr>
      <td style="white-space:nowrap" class="muted">${new Date(l.created_at).toLocaleString()}</td>
      <td><span class="b ${l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : ''}">${esc(l.area)}</span></td>
      <td>${esc(l.message)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card empty">Nothing yet.</div>';
  };
  $('#rl').onclick = load; $('#lv').onchange = load; load();
}

// ---------------- Whatnot products ----------------
const prod = { search: '', page: 1, rows: [], total: 0, sel: new Set() };
async function products() {
  $('#main').innerHTML = `<div class="page-head"><h1>Whatnot products</h1><span class="sp"></span>
      <span id="jobProgress" class="progress"></span>
      <a class="btn" href="#/import">⇪ Import from Shopify</a>
      <button class="btn primary" id="fullSync">↻ Refresh</button></div>
    <div class="toolbar"><input type="search" id="pq" placeholder="Search title or SKU…" value="${esc(prod.search)}" /></div>
    <div id="pbulk"></div><div id="ptbl"></div><div class="pager" id="ppager"></div>`;
  let t; $('#pq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { prod.search = e.target.value; prod.page = 1; loadProducts(); }, 300); };
  $('#fullSync').onclick = () => startFullSync(loadProducts);
  loadProducts();
}
async function loadProducts() {
  const r = await api('/products?' + new URLSearchParams({ search: prod.search, page: prod.page, limit: 50 }));
  prod.rows = r.rows; prod.total = r.total; renderProducts();
}
const money = (a, b) => (a == null ? '—' : a === b || b == null ? `$${fmt$(a)}` : `$${fmt$(a)}–${fmt$(b)}`);
function renderProducts() {
  const rows = prod.rows;
  $('#ptbl').innerHTML = rows.length ? `<div class="tbl-wrap cards"><table><thead><tr><th style="width:36px"><input type="checkbox" id="pall" /></th>
    <th>Product</th><th>Category</th><th class="num">Variants</th><th class="num">Qty</th><th class="num">Buy it now</th><th class="num">Auction</th><th>Format</th><th>Shopify</th><th></th></tr></thead>
    <tbody>${rows.map((p) => `<tr data-id="${esc(p.id)}">
      <td class="c-sel"><input type="checkbox" class="psel" ${prod.sel.has(p.id) ? 'checked' : ''} /></td>
      <td class="c-prod"><div class="prod">${p.image ? `<img class="thumb" src="${esc(p.image)}" loading="lazy" alt="" />` : '<div class="thumb"></div>'}<div><div class="t">${esc(p.title)}</div><div class="o mono">#${esc(p.id)}</div></div></div></td>
      <td data-l="Category">${esc(p.category_label || '—')}</td>
      <td data-l="Variants" class="num">${p.variants}</td>
      <td data-l="Qty" class="num"><b>${p.qty ?? 0}</b></td>
      <td data-l="Buy it now" class="num">${money(p.min_bin, p.max_bin)}</td>
      <td data-l="Auction" class="num">${p.min_auction ? '$' + fmt$(p.min_auction) : '—'}</td>
      <td data-l="Format">${p.transaction_type ? `<span class="b">${p.transaction_type === 'buy_it_now' ? 'Buy it now' : 'Auction'}${p.reserved_for_live ? ' · live' : ''}</span>` : '<span class="muted">—</span>'}</td>
      <td data-l="Shopify">${p.linked ? `<span class="b ${p.linked === p.variants ? 'ok' : 'warn'}">${p.linked}/${p.variants} linked</span>` : '<span class="b">not linked</span>'}</td>
      <td data-l=""><div class="row" style="justify-content:flex-end"><button class="btn sm" data-edit="1">Edit</button><button class="btn sm" data-upd="1" title="Re-send title, description, images and new sizes from Shopify">⟳ Shopify</button></div></td>
    </tr>`).join('')}</tbody></table></div>`
    : `<div class="card empty">${prod.search ? 'No match.' : 'No Whatnot products loaded yet. Click Refresh, or <a href="#/import">import from Shopify</a>.'}</div>`;
  $('#ppager').innerHTML = `<span class="muted">${prod.total} products</span>
    <button class="btn sm" id="pp" ${prod.page <= 1 ? 'disabled' : ''}>‹</button><span>${prod.page}</span>
    <button class="btn sm" id="pn" ${prod.page * 50 >= prod.total ? 'disabled' : ''}>›</button>`;
  $('#pp').onclick = () => { prod.page--; loadProducts(); };
  $('#pn').onclick = () => { prod.page++; loadProducts(); };
  const all = $('#pall'); if (all) all.onchange = (e) => { rows.forEach((p) => (e.target.checked ? prod.sel.add(p.id) : prod.sel.delete(p.id))); renderProducts(); };
  const tb = $('#ptbl tbody');
  if (tb) {
    tb.onchange = (e) => { if (!e.target.classList.contains('psel')) return; const id = e.target.closest('tr').dataset.id; e.target.checked ? prod.sel.add(id) : prod.sel.delete(id); renderPBulk(); };
    tb.onclick = async (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      if (e.target.dataset.edit) productEditor(tr.dataset.id);
      if (e.target.dataset.upd) {
        e.target.disabled = true;
        try { const r = await api(`/products/${tr.dataset.id}/update-from-shopify`, { method: 'POST', body: {} }); toast(`Updated from Shopify${r.warnings.length ? ' — ' + r.warnings.join('; ') : ''}`, r.warnings.length ? 'bad' : 'ok'); loadProducts(); }
        catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
      }
    };
  }
  renderPBulk();
}
function renderPBulk() {
  const n = prod.sel.size;
  if (!n) { $('#pbulk').innerHTML = ''; return; }
  $('#pbulk').innerHTML = `<div class="bulkbar"><b>${n} selected</b><span class="sp"></span>
    <button class="btn sm" id="pbEdit">✎ Bulk edit</button><button class="btn sm" id="pbUpd">⟳ Update from Shopify</button>
    <button class="btn sm" id="pbFmt">Sale format</button><button class="btn sm" id="pbDel">🗑 Delete</button><button class="btn sm" id="pbClr">✕</button></div>`;
  const ids = [...prod.sel];
  $('#pbClr').onclick = () => { prod.sel.clear(); renderProducts(); };
  $('#pbFmt').onclick = () => { inv.selProducts = new Map(ids.map((id) => [id, id])); bulkFormatModal(); };
  $('#pbDel').onclick = async () => {
    if (!confirmBox(`Delete ${n} product(s) from Whatnot? This can't be undone.`)) return;
    try { const r = await api('/products/delete', { method: 'POST', body: { ids } }); toast(`Deleted ${r.deleted}${r.errors.length ? `, ${r.errors.length} failed` : ''}`, r.errors.length ? 'bad' : 'ok'); prod.sel.clear(); loadProducts(); }
    catch (e) { toast(e.message, 'bad'); }
  };
  $('#pbUpd').onclick = () => modal(`<h2>Update ${n} products from Shopify</h2>
      <p class="muted">Re-sends title, description, images and any new sizes/colors, and refreshes SKU links and stock.</p>
      <label class="switch"><input type="checkbox" id="upPrices" /> Also overwrite Whatnot prices with Shopify price rules</label>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="upGo">Update</button></div>`, (el, close) => {
    $('#upGo', el).onclick = async () => {
      try { await api('/products/bulk-update-from-shopify', { method: 'POST', body: { ids, prices: $('#upPrices', el).checked } }); close(); toast('Updating…');
        watchNamedJob('update', (j) => { toast(`Updated ${j.result.updated}${j.result.failed ? `, ${j.result.failed} failed (see Activity)` : ''}`, j.result.failed ? 'bad' : 'ok'); loadProducts(); }); }
      catch (e) { toast(e.message, 'bad'); }
    };
  });
  $('#pbEdit').onclick = () => modal(`<h2>Bulk edit ${n} products</h2>
      <p class="muted">Leave a field empty to keep it as is.</p>
      <label class="f"><span>Move to category</span>${catPicker('bulkcat')}</label>
      <div class="grid g2" style="gap:0 12px">
        <label class="f"><span>Title: find</span><input type="text" id="bf" /></label>
        <label class="f"><span>…replace with</span><input type="text" id="br" /></label>
        <label class="f"><span>Title prefix</span><input type="text" id="bp" /></label>
        <label class="f"><span>Title suffix</span><input type="text" id="bs" /></label>
      </div>
      <label class="f"><span>Add to description</span><textarea id="bd"></textarea></label>
      <label class="f"><span>Set one field (category attribute)</span><div class="row" style="flex-wrap:nowrap"><select id="ba" style="flex:1"><option value="">— choose a category above or pick from common fields —</option>
        <option value="80">Brand</option><option value="73">Condition</option><option value="972">Color</option><option value="930">MSRP</option></select><input type="text" id="bv" placeholder="Value" style="flex:1" /></div></label>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="bgo">Apply to ${n}</button></div>`, (el, close) => {
    mountCatPicker('bulkcat', async (cid) => {
      const c = await api(`/categories/${cid}`);
      $('#ba', el).innerHTML = '<option value="">—</option>' + c.attributes.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
    }, el);
    $('#bgo', el).onclick = async () => {
      const changes = { category_id: catValue('bulkcat'), find: $('#bf', el).value, replace: $('#br', el).value, prefix: $('#bp', el).value, suffix: $('#bs', el).value,
        description_append: $('#bd', el).value.trim() || undefined };
      if ($('#ba', el).value && $('#bv', el).value) { changes.attribute_id = $('#ba', el).value; changes.attribute_value = $('#bv', el).value; }
      $('#bgo', el).disabled = true; $('#bgo', el).innerHTML = '<span class="spin"></span> Saving…';
      try { const r = await api('/products/bulk-edit', { method: 'POST', body: { ids, changes } }); toast(`Updated ${r.updated}${r.errors.length ? `, ${r.errors.length} failed` : ''}`, r.errors.length ? 'bad' : 'ok'); close(); loadProducts(); }
      catch (e) { toast(e.message, 'bad'); $('#bgo', el).disabled = false; }
    };
  });
}

function watchNamedJob(name, onDone) {
  const iv = setInterval(async () => {
    const jobs = await api('/jobs').catch(() => ({}));
    const j = jobs[name];
    const el = $('#jobProgress'); if (el) el.innerHTML = j?.running ? `<span class="spin"></span> ${esc(j.progress || '')}` : '';
    if (j && !j.running) { clearInterval(iv); if (j.error) toast(j.error, 'bad'); else onDone(j); }
  }, 1200);
}

async function productEditor(id) {
  modal('<div class="empty"><span class="spin"></span> Loading…</div>');
  $('#modalCard').classList.add('wide');
  let d;
  try { d = await api(`/products/${id}`); } catch (e) { $('#modalCard').innerHTML = `<p class="err">${esc(e.message)}</p><div class="modal-foot"><button class="btn" data-close>Close</button></div>`; $('#modalCard [data-close]').onclick = () => $('#modal').classList.add('hidden'); return; }
  const p = d.product;
  let media = (p.media || []).map((m) => ({ url: m.url, alt: m.alt }));
  const close = modal(`<h2>Edit Whatnot product</h2><p class="muted" style="margin-top:-6px">#${esc(p.id)} ${p.url ? `· <a href="${esc(p.url)}" target="_blank" rel="noopener">open on Whatnot</a>` : ''}${d.local.shopify_product_id ? ' · linked to Shopify' : ''}</p>
    <label class="f"><span>Title</span><input type="text" id="et" value="${esc(p.title)}" maxlength="200" /></label>
    <label class="f"><span>Description</span><textarea id="ed" style="min-height:120px">${esc(p.description || '')}</textarea></label>
    <label class="f"><span>Category</span>${catPicker('editcat', p.category?.id, d.category?.path || '')}</label>
    <div id="eattrs">${attrFields(d.category, p.attributes || [])}</div>
    <label class="f"><span>Images</span><div class="imgs" id="eimgs"></div>
      <div class="row" style="margin-top:6px;flex-wrap:nowrap"><input type="text" id="eimg" placeholder="Paste image URL" /><button class="btn" id="eadd">Add</button></div></label>
    <h2 style="margin-top:6px">Sizes / variants</h2>
    <div class="tbl-wrap"><table class="vtbl"><thead><tr><th>Variant</th><th>SKU</th><th class="num">Location → Whatnot</th><th class="num">Buy it now $</th><th class="num">Auction start $</th></tr></thead><tbody>
      ${d.variants.map((v) => `<tr data-vid="${esc(v.id)}"><td>${esc(v.options || '—')}</td><td class="mono">${esc(v.sku || '—')}</td>
        <td class="num"><span class="qwrap">${v.shop_sku ? (v.stocked ? v.shop_qty : 'n/s') : '—'} → <b>${v.wn_qty ?? '?'}</b></span></td>
        <td class="num"><input class="price-in" data-f="bin_price" value="${fmt$(v.bin_price)}" placeholder="—" inputmode="decimal" /></td>
        <td class="num"><input class="price-in" data-f="auction_price" value="${fmt$(v.auction_price)}" placeholder="—" inputmode="decimal" /></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:12.5px">Fill Buy-it-now, Auction start, or both — each one is saved on its own.</p>
    <div class="modal-foot"><button class="btn danger" id="edel">Delete</button><button class="btn" id="eupd">⟳ Update from Shopify</button><span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="esave">Save</button></div>`, (el) => {
    const renderImgs = () => { $('#eimgs', el).innerHTML = media.map((m, i) => `<div style="position:relative"><img src="${esc(m.url)}" alt="" /><button class="btn sm" data-rm="${i}" style="position:absolute;top:-6px;right:-6px;min-height:20px;padding:0 6px">×</button></div>`).join('') || '<span class="muted">No images</span>'; };
    renderImgs();
    $('#eimgs', el).onclick = (e) => { if (e.target.dataset.rm) { media.splice(Number(e.target.dataset.rm), 1); renderImgs(); } };
    $('#eadd', el).onclick = () => { const u = $('#eimg', el).value.trim(); if (/^https?:\/\//.test(u)) { media.push({ url: u, alt: '' }); $('#eimg', el).value = ''; renderImgs(); } else toast('Enter a full image URL (https://…)', 'bad'); };
    mountCatPicker('editcat', async (cid) => { const c = await api(`/categories/${cid}`); $('#eattrs', el).innerHTML = attrFields(c, readAttrs(el)); }, el);
    $('#edel', el).onclick = async () => {
      if (!confirmBox('Delete this product from Whatnot?')) return;
      try { await api('/products/delete', { method: 'POST', body: { ids: [id] } }); toast('Deleted', 'ok'); $('#modal').classList.add('hidden'); loadProducts(); } catch (e) { toast(e.message, 'bad'); }
    };
    $('#eupd', el).onclick = async () => {
      try { const r = await api(`/products/${id}/update-from-shopify`, { method: 'POST', body: {} }); toast(`Updated from Shopify${r.warnings.length ? ' — ' + r.warnings.join('; ') : ''}`, 'ok'); productEditor(id); } catch (e) { toast(e.message, 'bad'); }
    };
    $('#esave', el).onclick = async () => {
      $('#esave', el).disabled = true;
      try {
        const patch = { title: $('#et', el).value.trim(), description: $('#ed', el).value, attributes: readAttrs($('#eattrs', el)), media };
        if (catValue('editcat') && String(catValue('editcat')) !== String(p.category?.id)) patch.category_id = catValue('editcat');
        await api(`/products/${id}`, { method: 'PATCH', body: patch });
        for (const tr of el.querySelectorAll('[data-vid]')) {
          const v = d.variants.find((x) => x.id === tr.dataset.vid); const body = {};
          tr.querySelectorAll('.price-in').forEach((i) => { const val = i.value.trim(); if (val && val !== fmt$(v[i.dataset.f])) body[i.dataset.f] = val; });
          if (Object.keys(body).length) await api(`/variants/${v.id}`, { method: 'PATCH', body });
        }
        toast('Saved to Whatnot', 'ok'); $('#modal').classList.add('hidden'); $('#modalCard').classList.remove('wide');
        if (location.hash.includes('products')) loadProducts();
      } catch (e) { toast(e.message, 'bad'); $('#esave', el).disabled = false; }
    };
  });
  $('#modalCard').classList.add('wide');
  return close;
}

// ---------------- Import from Shopify ----------------
const imp = { mode: 'any', q: '', results: [], sel: new Set(), drafts: null };
async function importPage() {
  if (imp.drafts) return renderDrafts();
  $('#main').innerHTML = `<div class="page-head"><h1>Import from Shopify</h1><span class="sp"></span><span id="jobProgress" class="progress"></span></div>
    <div class="card" style="margin-bottom:14px">
      <div class="tabs" id="modes">${[['any', 'Anything'], ['name', 'Product name'], ['sku', 'SKU'], ['upc', 'UPC / barcode']].map(([k, l]) => `<button class="chip ${imp.mode === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div>
      <textarea id="iq" placeholder="Type a name, SKU or UPC. Paste many (one per line) to import in bulk.">${esc(imp.q)}</textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="isearch">Search Shopify</button><span class="muted" id="istat"></span></div>
    </div>
    <div id="ibulk"></div><div id="ires"></div>`;
  $('#modes').onclick = (e) => { if (!e.target.dataset.m) return; imp.mode = e.target.dataset.m; document.querySelectorAll('#modes .chip').forEach((c) => c.classList.toggle('on', c.dataset.m === imp.mode)); };
  $('#isearch').onclick = async () => {
    imp.q = $('#iq').value; if (!imp.q.trim()) return;
    $('#istat').innerHTML = '<span class="spin"></span> Searching…';
    try { imp.results = await api('/shopify/search?' + new URLSearchParams({ q: imp.q, mode: imp.mode })); imp.sel = new Set(imp.results.filter((p) => !p.wn_product_id).map((p) => p.id)); $('#istat').textContent = `${imp.results.length} products found`; renderResults(); }
    catch (e) { $('#istat').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
  $('#iq').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !imp.q.includes('\n') && !$('#iq').value.includes('\n')) { e.preventDefault(); $('#isearch').click(); } };
  if (imp.results.length) renderResults();
}
function renderResults() {
  const rows = imp.results;
  $('#ires').innerHTML = rows.length ? `<div class="tbl-wrap cards"><table><thead><tr><th style="width:36px"><input type="checkbox" id="iall" /></th><th>Shopify product</th><th>Vendor / type</th><th class="num">Variants</th><th class="num">Qty at location</th><th class="num">Price</th><th>Whatnot</th></tr></thead>
    <tbody>${rows.map((p) => { const qty = p.variants.reduce((a, v) => a + (v.stocked ? v.qty || 0 : 0), 0); const prices = p.variants.map((v) => Number(v.price));
      return `<tr data-id="${esc(p.id)}"><td class="c-sel"><input type="checkbox" class="isel" ${imp.sel.has(p.id) ? 'checked' : ''} /></td>
      <td class="c-prod"><div class="prod">${p.images[0] ? `<img class="thumb" src="${esc(p.images[0].url)}" loading="lazy" alt="" />` : '<div class="thumb"></div>'}<div><div class="t">${esc(p.title)}</div><div class="o mono">${esc(p.variants.map((v) => v.sku).filter(Boolean).slice(0, 3).join(', '))}${p.variants.length > 3 ? '…' : ''}</div></div></div></td>
      <td data-l="Vendor / type">${esc(p.vendor || '')}${p.productType ? ` · ${esc(p.productType)}` : ''}</td>
      <td data-l="Variants" class="num">${p.variants.length}</td>
      <td data-l="Qty at location" class="num"><b>${qty}</b></td>
      <td data-l="Price" class="num">${money(Math.min(...prices), Math.max(...prices))}</td>
      <td data-l="Whatnot">${p.wn_product_id ? `<span class="b ok">on Whatnot</span>` : '<span class="b">new</span>'}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="card empty">No products found.</div>';
  const all = $('#iall'); if (all) all.onchange = (e) => { rows.forEach((p) => (e.target.checked ? imp.sel.add(p.id) : imp.sel.delete(p.id))); renderResults(); };
  const tb = $('#ires tbody'); if (tb) tb.onchange = (e) => { if (!e.target.classList.contains('isel')) return; const id = e.target.closest('tr').dataset.id; e.target.checked ? imp.sel.add(id) : imp.sel.delete(id); renderIBulk(); };
  renderIBulk();
}
function renderIBulk() {
  const n = imp.sel.size;
  $('#ibulk').innerHTML = n ? `<div class="bulkbar"><b>${n} selected</b><span class="sp"></span><button class="btn sm" id="ireview">Review & send to Whatnot →</button></div>` : '';
  const b = $('#ireview'); if (b) b.onclick = async () => {
    b.disabled = true; b.innerHTML = '<span class="spin"></span> Mapping fields…';
    try { imp.drafts = await api('/import/preview', { method: 'POST', body: { ids: [...imp.sel] } }); renderDrafts(); }
    catch (e) { toast(e.message, 'bad'); b.disabled = false; b.textContent = 'Review & send to Whatnot →'; }
  };
}

function draftSummary(d) {
  const bins = d.variants.map((v) => Number(v.bin) || 0), qty = d.variants.reduce((a, v) => a + (v.qty || 0), 0);
  return `${d.variants.length} variant${d.variants.length > 1 ? 's' : ''} · qty ${qty} · BIN ${money(Math.min(...bins), Math.max(...bins))}`;
}
async function renderDrafts() {
  const ds = imp.drafts;
  $('#main').innerHTML = `<div class="page-head"><button class="btn" id="dback">← Back</button><h1>Review ${ds.length} listing${ds.length > 1 ? 's' : ''}</h1><span class="sp"></span><span id="jobProgress" class="progress"></span></div>
    <div class="card" style="margin-bottom:14px"><div class="grid g2" style="gap:0 12px">
      <label class="f"><span>Category for all</span>${catPicker('allcat')}</label>
      <label class="f"><span>Sell as (all)</span><select id="allsf"><option value="">Keep each</option><option value="buy_it_now">Buy it now</option><option value="auction">Auction</option></select></label>
    </div>
    <div class="row"><label class="switch" style="margin:0"><input type="checkbox" id="allpub" /> Publish all to my Whatnot shop</label><span style="flex:1"></span>
      <button class="btn primary" id="dcreate">Create ${ds.length} on Whatnot</button></div></div>
    <div id="drafts">${ds.map((d, i) => draftCard(d, i)).join('')}</div><div id="dres"></div>`;
  $('#dback').onclick = () => { imp.drafts = null; importPage(); };
  $('#allpub').checked = ds.every((d) => d.publish);
  mountCatPicker('allcat', async (cid) => {
    toast('Re-mapping fields for the new category…');
    imp.drafts = await Promise.all(collectDrafts().map(async (d) => {
      const [nd] = await api('/import/preview', { method: 'POST', body: { ids: [d.shopify_product_id], overrides: { category_id: cid, sale_format: d.sale_format, publish: d.publish } } });
      return { ...nd, title: d.title, description: d.description, variants: nd.variants.map((v, k) => ({ ...v, bin: d.variants[k]?.bin ?? v.bin, auction: d.variants[k]?.auction ?? v.auction })) };
    }));
    renderDrafts();
  });
  $('#allsf').onchange = (e) => { if (!e.target.value) return; document.querySelectorAll('[data-sf]').forEach((x) => { x.value = e.target.value; }); };
  $('#allpub').onchange = (e) => document.querySelectorAll('[data-pub]').forEach((x) => { x.checked = e.target.checked; });
  ds.forEach((_, i) => mountCatPicker(`dcat${i}`, onDraftCat(i)));
  ds.forEach((_, i) => bindDraft(i));
  $('#dcreate').onclick = createDrafts;
}
function onDraftCat(i) {
  return async (cid) => {
    const cur = collectDrafts()[i];
    const [nd] = await api('/import/preview', { method: 'POST', body: { ids: [cur.shopify_product_id], overrides: { category_id: cid } } });
    imp.drafts[i] = { ...nd, title: cur.title, description: cur.description, sale_format: cur.sale_format, publish: cur.publish,
      variants: nd.variants.map((v, k) => ({ ...v, bin: cur.variants[k]?.bin ?? v.bin, auction: cur.variants[k]?.auction ?? v.auction })) };
    $(`#draft-${i}`).outerHTML = draftCard(imp.drafts[i], i, true); bindDraft(i);
  };
}
function bindDraft(i) {
  const card = $(`#draft-${i}`);
  card.querySelector('.draft-head').onclick = (e) => { if (e.target.closest('input,select,label')) return; card.querySelector('.draft-body').classList.toggle('hidden'); };
  if (card.dataset.remount) mountCatPicker(`dcat${i}`, onDraftCat(i), card);
}
function draftCard(d, i, open = false) {
  catState[`dcat${i}`] = { id: d.category_id, label: d.category_path || '' };
  const warn = [];
  if (d.existing_wn_product_id) warn.push(`<span class="b warn">already on Whatnot (#${esc(d.existing_wn_product_id)})</span>`);
  if (!d.category_id) warn.push('<span class="b bad">pick a category</span>');
  if (d.missing?.length) warn.push(`<span class="b bad">missing: ${esc(d.missing.join(', '))}</span>`);
  const cat = d.category_attributes?.length ? { attributes: d.category_attributes } : null;
  return `<div class="draft" id="draft-${i}" data-i="${i}" ${open ? 'data-remount="1"' : ''}>
    <div class="draft-head">${d.media[0] ? `<img class="thumb" src="${esc(d.media[0].url)}" alt="" />` : '<div class="thumb"></div>'}
      <div><div class="t">${esc(d.title)}</div><div class="muted" style="font-size:12.5px">${esc(d.category_path || 'No category')} · ${draftSummary(d)}</div><div>${warn.join(' ')}</div></div>
      <span class="sp"></span><label class="row" style="gap:6px;font-size:13px"><input type="checkbox" class="dinc" checked /> include</label><button class="btn sm">Edit ▾</button></div>
    <div class="draft-body ${open ? '' : 'hidden'}">
      <label class="f"><span>Title</span><input type="text" class="dt" value="${esc(d.title)}" maxlength="200" /></label>
      <label class="f"><span>Description</span><textarea class="dd">${esc(d.description)}</textarea></label>
      <label class="f"><span>Category</span>${catPicker(`dcat${i}`, d.category_id, d.category_path || '')}</label>
      <div class="dattrs">${attrFields(cat, d.attributes)}</div>
      <label class="f"><span>Images (${d.media.length})</span><div class="imgs">${d.media.map((m) => `<img src="${esc(m.url)}" alt="" />`).join('')}</div></label>
      <div class="grid g2" style="gap:0 12px">
        <label class="f"><span>Sell as</span><select data-sf="1" class="dsf"><option value="buy_it_now" ${d.sale_format === 'buy_it_now' ? 'selected' : ''}>Buy it now</option><option value="auction" ${d.sale_format === 'auction' ? 'selected' : ''}>Auction</option></select></label>
        <label class="switch" style="margin-top:22px"><input type="checkbox" data-pub="1" class="dpub" ${d.publish ? 'checked' : ''} /> Publish to my shop</label>
      </div>
      <div class="row" style="margin-bottom:8px;gap:6px"><span class="muted" style="font-size:13px">Set all:</span>
        <input type="number" class="setbin" placeholder="BIN $" style="width:100px" /><input type="number" class="setauc" placeholder="Auction $" style="width:110px" /><button class="btn sm dsetall" type="button">Apply</button></div>
      <div class="tbl-wrap"><table class="vtbl"><thead><tr><th>Variant</th><th>SKU</th><th>UPC</th><th class="num">Qty</th><th class="num">Shopify $</th><th class="num">Buy it now $</th><th class="num">Auction start $</th></tr></thead><tbody>
        ${d.variants.map((v, k) => `<tr data-k="${k}"><td>${esc(Object.values(v.options).join(' / ') || v.title)}</td><td class="mono">${esc(v.sku || '—')}</td><td class="mono">${esc(v.barcode || '—')}</td>
          <td class="num">${v.stocked ? v.qty : '<span class="b warn">n/s</span>'}</td><td class="num">${fmt$(v.shopify_price)}</td>
          <td class="num"><input class="price-in vbin" value="${v.bin ? fmt$(v.bin) : ''}" placeholder="—" inputmode="decimal" /></td>
          <td class="num"><input class="price-in vauc" value="${v.auction ? fmt$(v.auction) : ''}" placeholder="—" inputmode="decimal" /></td></tr>`).join('')}
      </tbody></table></div>
    </div></div>`;
}
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('dsetall')) return;
  const body = e.target.closest('.draft-body');
  const b = body.querySelector('.setbin').value, a = body.querySelector('.setauc').value;
  if (b) body.querySelectorAll('.vbin').forEach((x) => { x.value = Number(b).toFixed(2); });
  if (a) body.querySelectorAll('.vauc').forEach((x) => { x.value = Number(a).toFixed(2); });
});
function collectDrafts() {
  return imp.drafts.map((d, i) => {
    const card = $(`#draft-${i}`);
    return {
      ...d, include: card.querySelector('.dinc').checked,
      title: card.querySelector('.dt').value.trim(), description: card.querySelector('.dd').value,
      category_id: catValue(`dcat${i}`) || d.category_id,
      attributes: readAttrs(card.querySelector('.dattrs')).length ? readAttrs(card.querySelector('.dattrs')) : d.attributes,
      sale_format: card.querySelector('.dsf').value, publish: card.querySelector('.dpub').checked,
      variants: d.variants.map((v, k) => { const tr = card.querySelector(`tr[data-k="${k}"]`);
        return { ...v, bin: Number(tr.querySelector('.vbin').value) || null, auction: Number(tr.querySelector('.vauc').value) || null }; }),
    };
  });
}
async function createDrafts() {
  const all = collectDrafts(); const drafts = all.filter((d) => d.include);
  if (!drafts.length) return toast('Nothing included', 'bad');
  const problems = drafts.filter((d) => !d.category_id || (d.sale_format === 'auction' ? d.variants.some((v) => !v.auction) : d.variants.some((v) => !v.bin)));
  if (problems.length) return toast(`${problems.length} listing(s) need a category and a ${'price on every variant'} for the chosen sale format`, 'bad');
  $('#dcreate').disabled = true;
  try {
    await api('/import/create', { method: 'POST', body: { drafts } });
    watchNamedJob('import', (j) => {
      $('#dcreate').remove();
      const r = j.result;
      $('#dres').innerHTML = `<div class="card"><h2>Done — ${r.created} created${r.failed ? `, ${r.failed} failed` : ''}</h2>${r.results.map((x) => `<div style="padding:6px 0;border-bottom:1px dashed var(--line)">
        ${x.ok ? `<span class="result-ok">✓</span> <b>${esc(x.title)}</b> → #${esc(x.product_id)} ${x.published ? '<span class="b ok">published</span>' : '<span class="b">draft</span>'} ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">open</a>` : ''}
          ${x.warnings?.length ? `<div class="muted" style="font-size:12.5px">${esc(x.warnings.join(' · '))}</div>` : ''}`
        : `<span class="result-bad">✕</span> <b>${esc(x.title)}</b> <div class="err" style="font-size:12.5px">${esc(x.error)}</div>`}</div>`).join('')}
        <div class="row" style="margin-top:10px"><a class="btn" href="#/products">View Whatnot products</a><button class="btn" id="dnew">Import more</button></div></div>`;
      $('#dnew').onclick = () => { imp.drafts = null; imp.results = []; imp.sel.clear(); importPage(); };
      $('#dres').scrollIntoView({ behavior: 'smooth' });
      toast(`${r.created} listing(s) created`, r.failed ? 'bad' : 'ok');
    });
  } catch (e) { toast(e.message, 'bad'); $('#dcreate').disabled = false; }
}

boot();

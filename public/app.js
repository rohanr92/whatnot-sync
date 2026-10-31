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
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Login required'); }
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
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const close = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') close(); };
  $('#modalCard').querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  onMount?.($('#modalCard'), close);
  return close;
}

// ---------------- auth ----------------
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus(); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/login', { method: 'POST', body: { password: $('#pw').value } }); $('#login').classList.add('hidden'); boot(); }
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

const views = { dash, inventory, orders, settings, logs };
async function route() {
  const v = (location.hash.replace('#/', '') || 'dash').split('?')[0] || 'dash';
  const name = views[v] ? v : 'dash';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === name));
  try { await views[name](); } catch (e) { if (e.message !== 'Login required') $('#main').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.authed) return showLogin();
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
        close(); loadInv();
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
  $('#otbl').innerHTML = `<div class="tbl-wrap cards"><table><thead><tr><th>Whatnot order</th><th>Date</th><th>Buyer</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Shopify</th><th></th></tr></thead>
    <tbody>${rows.map((o) => `<tr>
      <td class="c-prod"><b class="mono">#${esc(o.wn_order_id)}</b></td>
      <td data-l="Date">${o.wn_created_at ? new Date(o.wn_created_at).toLocaleString() : '—'}</td>
      <td data-l="Buyer">${o.buyer ? '@' + esc(o.buyer) : '—'}</td>
      <td data-l="Items"><div>${(o.items || []).map((i) => `<div style="white-space:nowrap">${i.quantity}× <span class="mono">${esc(i.sku || i.title)}</span>${i.shop_variant_id ? '' : ' <span class="b warn">no match</span>'}</div>`).join('') || '—'}</div></td>
      <td data-l="Total" class="num">${esc(o.total || '')}</td>
      <td data-l="Status"><div><span class="b ${ORDER_BADGE[o.status] || ''}" title="${esc(o.error || '')}">${esc(o.status)}</span>${o.error ? `<div class="muted" style="font-size:12px;max-width:260px">${esc(o.error)}</div>` : ''}</div></td>
      <td data-l="Shopify">${esc(o.shopify_order_name || '—')}</td>
      <td data-l="">${['error', 'processing', 'order_created', 'skipped'].includes(o.status) ? `<button class="btn sm" data-retry="${esc(o.wn_order_id)}">Retry</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
  $('#otbl').onclick = async (e) => {
    const id = e.target.dataset.retry; if (!id) return;
    e.target.disabled = true;
    try { const r = await api(`/orders/${id}/retry`, { method: 'POST' }); toast(r.skipped || `Imported ${r.shopify_order || ''}`, 'ok'); orders(); }
    catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
  };
}

// ---------------- settings ----------------
async function settings() {
  await refreshStatus();
  const s = status.settings, env = status.env;
  const ck = (ok, label, hint = '') => `<li><span class="b ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span><div>${label}${hint && !ok ? `<div class="muted" style="font-size:12px">${hint}</div>` : ''}</div></li>`;
  $('#main').innerHTML = `<div class="page-head"><h1>Settings</h1><span class="sp"></span><button class="btn" id="testBtn">Test connections</button></div>
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
        <small>Products listed through the Shopify channel also match by Shopify variant ID automatically.</small></label>
      <label class="switch"><input type="checkbox" id="push" ${s.push_enabled ? 'checked' : ''} /> Instantly push stock changes to Whatnot</label>
      <label class="switch"><input type="checkbox" id="zu" ${s.zero_unmatched ? 'checked' : ''} /> Set unmatched Whatnot variants to 0</label>
      <p class="muted" style="margin:-6px 0 0;font-size:12.5px">Turn on so nothing sells on Whatnot unless it's stocked at this location.</p>
    </div>
    <div class="card">
      <h2>2 · Whatnot orders → Shopify</h2>
      <label class="f"><span>When a Whatnot order comes in</span><select id="om">
        <option value="create_order">Create a Shopify order + deduct stock at the location</option>
        <option value="deduct_only">Only deduct stock at the location (no Shopify order)</option>
        <option value="off">Do nothing</option></select>
        <small>Use "deduct only" if another app already creates the Shopify orders. Only orders after
        ${s.orders_since ? `<b>${new Date(s.orders_since).toLocaleString()}</b>` : 'the moment you turn this on'} are imported.</small></label>
      <label class="f"><span>Full re-check every (minutes)</span><input type="number" id="rm" min="5" value="${esc(s.reconcile_minutes)}" />
        <small>Catches anything a webhook missed.</small></label>
      <label class="f"><span>Default price rounding</span><select id="rd"><option value="none">Exact</option><option value="99">End in .99</option><option value="whole">Whole dollars</option></select></label>
      <button class="btn primary block" id="save">Save settings</button>
    </div>
    <div class="card">
      <h2>3 · Webhooks (instant sync)</h2>
      <p class="muted">Shopify: click below once after deploying. Whatnot: paste this URL in the
        <a href="https://www.whatnot.com/dashboard/developer" target="_blank" rel="noopener">Whatnot developer dashboard</a> → Webhooks, and subscribe to
        <span class="mono">orders.created</span>, <span class="mono">orders.updated</span>, <span class="mono">products.created</span>, <span class="mono">products.updated</span>, <span class="mono">products.deleted</span>.</p>
      <label class="f"><span>Whatnot webhook URL</span><div class="copy"><input type="text" readonly id="wurl" value="${esc(status.app_url)}/webhooks/whatnot" /><button class="btn" id="cp">Copy</button></div></label>
      <button class="btn" id="regWh">Register Shopify webhooks</button>
      <div id="whRes" class="muted" style="margin-top:8px;font-size:13px"></div>
    </div>
    <div class="card">
      <h2>Environment check</h2>
      <ul class="check-list">
        ${ck(env.shopify, 'Shopify API credentials', 'Set SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN (or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)')}
        ${ck(env.shopify_webhook_secret, 'Shopify webhook secret', 'Set SHOPIFY_CLIENT_SECRET (or SHOPIFY_API_SECRET) so webhooks can be verified')}
        ${ck(env.whatnot, 'Whatnot API key', 'Set WHATNOT_API_KEY (needs read/write inventory + read orders)')}
        ${ck(env.whatnot_webhook_secret, 'Whatnot webhook secret', 'Set WHATNOT_WEBHOOK_SECRET (wn_wh_…) from the developer dashboard')}
        ${ck(env.password, 'App password', 'Set APP_PASSWORD so only you can open this app')}
      </ul>
      <div id="testRes" style="margin-top:10px"></div>
    </div>
  </div>`;
  $('#mb').value = s.match_by; $('#om').value = s.orders_mode; $('#rd').value = s.rounding || 'none';
  api('/locations').then((locs) => {
    $('#loc').innerHTML = '<option value="">— choose a location —</option>' + locs.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}${l.address?.city ? ' · ' + esc(l.address.city) : ''}</option>`).join('');
    $('#loc').value = s.location_id || '';
  }).catch((e) => { $('#loc').innerHTML = `<option value="">Can't load: ${esc(e.message)}</option>`; });
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
      reconcile_minutes: $('#rm').value, rounding: $('#rd').value, zero_unmatched: $('#zu').checked };
    if ($('#loc').value && $('#loc').value !== s.location_id) body.location_id = $('#loc').value;
    try {
      await api('/settings', { method: 'POST', body });
      toast(body.location_id ? 'Saved — loading products from the new location…' : 'Saved', 'ok');
      await refreshStatus();
      if (body.location_id) location.hash = '#/';
    } catch (e) { toast(e.message, 'bad'); }
  };
}

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

boot();

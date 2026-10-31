import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q, getSettings, saveSettings, log, firstTime } from './db.js';
import * as shopify from './shopify.js';
import * as wn from './whatnot.js';
import * as sync from './sync.js';
import * as auth from './auth.js';
import * as tax from './taxonomy.js';
import * as listings from './listings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const appUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// ---------- webhooks (raw body, before JSON parser) ----------
const raw = express.raw({ type: '*/*', limit: '5mb' });

app.post('/webhooks/shopify', raw, async (req, res) => {
  if (!shopify.verifyWebhook(req.body, req.get('x-shopify-hmac-sha256'))) {
    await log('warn', 'webhook', 'Shopify webhook with bad HMAC rejected'); return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast, work after
  const topic = req.get('x-shopify-topic');
  const id = req.get('x-shopify-webhook-id') || req.get('x-shopify-event-id') || crypto.randomUUID();
  try {
    if (!(await firstTime(`s:${id}`, 'shopify'))) return;
    const body = JSON.parse(req.body.toString('utf8'));
    if (topic?.startsWith('inventory_levels/')) await sync.onShopifyInventory(topic, body);
    else if (topic === 'products/update') await sync.onShopifyProduct(body);
    else if (topic?.startsWith('fulfillments/')) await sync.onShopifyFulfillment(body);
  } catch (e) { await log('error', 'webhook', `Shopify ${topic}: ${e.message}`); }
});

app.post('/webhooks/whatnot', raw, async (req, res) => {
  const v = wn.verifyWebhook(req.body, req.headers);
  if (!v.ok) { await log('warn', 'webhook', `Whatnot webhook rejected: ${v.reason}`); return res.sendStatus(401); }
  res.sendStatus(200);
  try {
    if (!(await firstTime(`w:${req.get('webhook-id')}`, 'whatnot'))) return;
    const evt = JSON.parse(req.body.toString('utf8'));
    await log('info', 'webhook', `Whatnot ${evt.type} ${evt.data?.id || ''}`);
    await sync.onWhatnotEvent(evt);
  } catch (e) { await log('error', 'webhook', `Whatnot: ${e.message}`); }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---------- auth (user accounts) ----------
app.use(express.json({ limit: '5mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(e); res.status(e.status && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 500).json({ error: e.message });
});

app.get('/api/me', wrap(async (req, res) => {
  const user = await auth.currentUser(req);
  res.json({ user, needsSetup: !user && (await auth.userCount()) === 0 });
}));
app.post('/api/setup', wrap(async (req, res) => {
  if ((await auth.userCount()) > 0) return res.status(403).json({ error: 'Setup already done — log in instead' });
  const u = await auth.createUser({ ...req.body, role: 'admin' });
  await auth.startSession(res, req, u.id);
  await log('info', 'auth', `Admin account created: ${u.email}`);
  res.json({ user: u });
}));
app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const key = `${req.ip}|${email}`;
  if (auth.tooManyAttempts(key)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  const { rows: [u] } = await q('SELECT * FROM users WHERE email=$1', [email]);
  if (!u || !(await auth.checkPassword(String(req.body?.password || ''), u.password_hash))) {
    auth.recordFail(key); return res.status(401).json({ error: 'Wrong email or password' });
  }
  auth.clearFails(key);
  await auth.startSession(res, req, u.id);
  res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
}));
app.post('/api/logout', wrap(async (req, res) => { await auth.endSession(req, res); res.json({ ok: true }); }));
app.use('/api', wrap(async (req, res, next) => {
  const u = await auth.currentUser(req);
  if (!u) return res.status(401).json({ error: 'Login required' });
  req.user = u; next();
}));
const adminOnly = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

app.post('/api/me/password', wrap(async (req, res) => {
  const { current, password } = req.body || {};
  const { rows: [u] } = await q('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!(await auth.checkPassword(String(current || ''), u.password_hash))) return res.status(400).json({ error: 'Current password is wrong' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await q('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await auth.hashPassword(password)]);
  res.json({ ok: true });
}));
app.get('/api/users', adminOnly, wrap(async (_req, res) => {
  res.json((await q('SELECT id,email,name,role,created_at,last_login FROM users ORDER BY id')).rows);
}));
app.post('/api/users', adminOnly, wrap(async (req, res) => {
  const u = await auth.createUser(req.body || {});
  await log('info', 'auth', `${req.user.email} added user ${u.email} (${u.role})`);
  res.json(u);
}));
app.delete('/api/users/:id', adminOnly, wrap(async (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: "You can't remove yourself" });
  await q('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- status & settings ----------
app.get('/api/status', wrap(async (req, res) => {
  const s = await getSettings();
  const out = { settings: s, user: req.user, app_url: appUrl(req), env: {
    shopify: !!process.env.SHOPIFY_SHOP && !!(process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_CLIENT_ID),
    shopify_webhook_secret: !!(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET),
    whatnot: !!process.env.WHATNOT_API_KEY, whatnot_webhook_secret: !!process.env.WHATNOT_WEBHOOK_SECRET,
  } };
  const [counts] = (await q(`SELECT
      (SELECT count(*) FROM wn_variants)::int AS wn_variants,
      (SELECT count(*) FROM shop_variants)::int AS shop_variants,
      (SELECT count(*) FROM links)::int AS linked,
      (SELECT count(*) FROM wn_variants w JOIN links l ON l.wn_variant_id=w.id JOIN shop_variants sv ON sv.id=l.shop_variant_id
         WHERE w.wn_qty IS DISTINCT FROM (CASE WHEN sv.stocked THEN GREATEST(0, coalesce(sv.qty,0) - $1) ELSE 0 END))::int AS out_of_sync,
      (SELECT count(*) FROM orders WHERE status='error')::int AS order_errors,
      (SELECT count(*) FROM orders WHERE created_at > now() - interval '24 hours' AND status IN ('imported','deducted'))::int AS orders_24h,
      (SELECT max(created_at) FROM logs WHERE area='inventory') AS last_push`, [Number(s.buffer) || 0])).rows;
  out.counts = counts;
  out.jobs = sync.jobs;
  res.json(out);
}));

app.get('/api/test', wrap(async (_req, res) => {
  const out = {};
  try { out.shopify = { ok: true, ...(await shopify.shopInfo()) }; } catch (e) { out.shopify = { ok: false, error: e.message }; }
  try { await wn.health(); out.whatnot = { ok: true }; } catch (e) { out.whatnot = { ok: false, error: e.message }; }
  res.json(out);
}));

app.get('/api/locations', wrap(async (_req, res) => res.json(await shopify.locations())));

app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.location_id !== undefined) {
    patch.location_id = b.location_id;
    const loc = (await shopify.locations()).find((l) => l.id === b.location_id);
    if (!loc) throw Object.assign(new Error('Location not found'), { status: 400 });
    patch.location_name = loc.name;
  }
  for (const k of ['match_by', 'push_enabled', 'orders_mode', 'reconcile_minutes', 'rounding', 'zero_unmatched', 'tracking_enabled',
    'default_category_id', 'category_map', 'dimension_profile_id', 'default_dims', 'default_condition', 'price_source',
    'price_markup_pct', 'auction_start_pct', 'default_sale_format', 'auto_publish']) if (b[k] !== undefined) patch[k] = b[k];
  if (b.price_markup_pct !== undefined) patch.price_markup_pct = Number(b.price_markup_pct) || 0;
  if (b.auction_start_pct !== undefined) patch.auction_start_pct = b.auction_start_pct === '' || b.auction_start_pct === null ? null : Number(b.auction_start_pct);
  if (b.buffer !== undefined) patch.buffer = Math.max(0, parseInt(b.buffer, 10) || 0);
  if (b.reconcile_minutes !== undefined) patch.reconcile_minutes = Math.max(5, parseInt(b.reconcile_minutes, 10) || 15);
  const before = await getSettings();
  if (b.orders_mode && b.orders_mode !== 'off' && (before.orders_mode === 'off' || !before.orders_since)) patch.orders_since = new Date().toISOString();
  if (b.orders_since !== undefined) patch.orders_since = b.orders_since || null;
  const s = await saveSettings(patch);
  if (patch.location_id && patch.location_id !== before.location_id) {
    await q('DELETE FROM shop_variants');
    sync.runJob('sync', sync.fullSync);
  }
  if (patch.match_by) await sync.relink();
  scheduleReconcile();
  await log('info', 'settings', `Settings saved: ${Object.keys(patch).join(', ')}`);
  res.json(s);
}));

app.post('/api/webhooks/register', wrap(async (req, res) => {
  const result = await shopify.registerWebhooks(appUrl(req));
  await log('info', 'webhook', `Shopify webhooks: ${result.map((r) => `${r.topic} ${r.status}`).join(', ')}`);
  res.json({ shopify: result, whatnot_url: `${appUrl(req)}/webhooks/whatnot` });
}));

// ---------- sync jobs ----------
app.post('/api/sync/full', wrap(async (_req, res) => res.json(sync.runJob('sync', sync.fullSync))));
app.post('/api/sync/push', wrap(async (req, res) => {
  const { ids, force } = req.body || {};
  res.json(await sync.pushInventory({ wnIds: ids?.length ? ids : null, force: !!force, reason: ids?.length ? 'manual (selected)' : 'manual (all)' }));
}));
app.post('/api/sync/orders', wrap(async (_req, res) => res.json(await sync.pollOrders())));
app.get('/api/jobs', (_req, res) => res.json(sync.jobs));

// ---------- variants ----------
function variantFilter(query, s) {
  const { search = '', filter = 'all' } = query;
  const where = []; const params = [Number(s.buffer) || 0];
  if (search) { params.push(`%${String(search).toLowerCase()}%`); where.push(`(lower(w.product_title) LIKE $${params.length} OR lower(coalesce(w.sku,'')) LIKE $${params.length} OR lower(coalesce(w.options,'')) LIKE $${params.length} OR lower(coalesce(sv.sku,'')) LIKE $${params.length})`); }
  const want = `(CASE WHEN sv.stocked THEN GREATEST(0, coalesce(sv.qty,0) - $1) ELSE 0 END)`;
  if (filter === 'matched') where.push('l.shop_variant_id IS NOT NULL');
  if (filter === 'unmatched') where.push('l.shop_variant_id IS NULL');
  if (filter === 'diff') where.push(`l.shop_variant_id IS NOT NULL AND w.wn_qty IS DISTINCT FROM ${want}`);
  if (filter === 'notstocked') where.push('l.shop_variant_id IS NOT NULL AND NOT sv.stocked');
  if (filter === 'noprice') where.push('w.bin_price IS NULL AND w.auction_price IS NULL');
  const from = `FROM wn_variants w LEFT JOIN links l ON l.wn_variant_id=w.id LEFT JOIN shop_variants sv ON sv.id=l.shop_variant_id
     LEFT JOIN wn_products p ON p.id=w.product_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return { from, params, want };
}

app.get('/api/variants', wrap(async (req, res) => {
  const s = await getSettings();
  const { page = '1', limit = '50', sort = 'product' } = req.query;
  const { from, params, want } = variantFilter(req.query, s);
  const order = { product: 'w.product_title, w.options', sku: 'w.sku', qty: 'sv.qty DESC NULLS LAST', price: 'w.bin_price DESC NULLS LAST' }[sort] || 'w.product_title, w.options';
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const off = (Math.max(1, parseInt(page, 10) || 1) - 1) * lim;
  const { rows } = await q(`SELECT w.*, l.match_type, l.manual, sv.id AS shop_id, sv.sku AS shop_sku, sv.barcode AS shop_barcode, sv.title AS shop_title,
      sv.product_title AS shop_product, sv.price AS shop_price, sv.qty AS shop_qty, sv.stocked,
      ${want} AS target_qty, p.transaction_type, p.reserved_for_live, p.url AS wn_url
      ${from} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`, params);
  const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n, max($1::int) AS _b ${from}`, params);
  res.json({ rows, total: n, page: Number(page), limit: lim });
}));

// all ids matching the current filter ("select all")
app.get('/api/variants/ids', wrap(async (req, res) => {
  const { from, params } = variantFilter(req.query, await getSettings());
  const { rows } = await q(`SELECT w.id, w.product_id, $1::int AS _b ${from}`, params);
  res.json({ items: rows.map((r) => [r.id, r.product_id]) });
}));

app.patch('/api/variants/:id', wrap(async (req, res) => {
  const { bin_price, auction_price, link } = req.body || {};
  const out = {};
  if (link !== undefined) { out.linked = await sync.setManualLink(req.params.id, String(link).trim()); }
  if (bin_price !== undefined || auction_price !== undefined) {
    out.prices = await sync.applyPrices([{ id: req.params.id,
      bin: bin_price === '' || bin_price == null ? null : Number(bin_price),
      auction: auction_price === '' || auction_price == null ? null : Number(auction_price) }]);
    if (out.prices.errors.length) throw Object.assign(new Error(out.prices.errors.join('; ')), { status: 422 });
  }
  if (link !== undefined) {
    const s = await getSettings();
    if (s.push_enabled) out.push = await sync.pushInventory({ wnIds: [req.params.id], reason: 'manual link' });
  }
  res.json(out);
}));

app.post('/api/variants/bulk-price', wrap(async (req, res) => {
  const { ids, field, mode, value, rounding } = req.body || {};
  if (!ids?.length) throw Object.assign(new Error('Select variants first'), { status: 400 });
  if (!['bin', 'auction'].includes(field)) throw Object.assign(new Error('field must be bin or auction'), { status: 400 });
  res.json(await sync.bulkPrice({ ids, field, mode, value, rounding: rounding || (await getSettings()).rounding }));
}));

app.post('/api/variants/preview-price', wrap(async (req, res) => {
  const { ids, field, mode, value, rounding } = req.body || {};
  const { rows } = await q(`SELECT w.id, w.product_title, w.options, w.bin_price, w.auction_price, sv.price AS shop_price FROM wn_variants w
      LEFT JOIN links l ON l.wn_variant_id=w.id LEFT JOIN shop_variants sv ON sv.id=l.shop_variant_id WHERE w.id = ANY($1) LIMIT 5`, [ids || []]);
  res.json(rows.map((r) => ({ ...r, new_price: sync.computePrice(r, field, mode, value, rounding) })));
}));

app.post('/api/products/merch', wrap(async (req, res) => {
  const { product_ids, transaction_type, reserve_for_live } = req.body || {};
  if (!product_ids?.length) throw Object.assign(new Error('Select products first'), { status: 400 });
  res.json(await sync.bulkMerch({ productIds: product_ids, transaction_type, reserve_for_live }));
}));

// ---------- categories & shipping profiles ----------
app.get('/api/categories', wrap(async (req, res) => {
  const qs = String(req.query.search || '').toLowerCase();
  const list = await tax.categories();
  res.json(qs ? list.filter((c) => c.path.toLowerCase().includes(qs)).slice(0, 60) : list);
}));
app.get('/api/categories/:id', wrap(async (req, res) => {
  const c = await tax.categoryInfo(req.params.id);
  if (!c) return res.status(404).json({ error: 'Category not found' });
  res.json(c);
}));
app.get('/api/dimension-profiles', wrap(async (_req, res) => res.json(await wn.dimensionProfiles())));

// ---------- Shopify import -> Whatnot listings ----------
app.get('/api/shopify/search', wrap(async (req, res) => {
  const s = await getSettings();
  if (!s.location_id) throw Object.assign(new Error('Pick a Shopify location in Settings first'), { status: 400 });
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.json([]);
  const terms = raw.split(/[\n,;\t]+/).map((t) => t.trim()).filter(Boolean);
  const products = await shopify.searchProducts(terms, req.query.mode || 'any', s.location_id);
  const on = await listings.onWhatnot(products.map((p) => p.id));
  res.json(products.map((p) => ({ ...p, wn_product_id: on[p.id] || null })));
}));
app.post('/api/import/preview', wrap(async (req, res) => {
  const { ids, overrides } = req.body || {};
  if (!ids?.length) throw Object.assign(new Error('Select products first'), { status: 400 });
  res.json(await listings.previewImport(ids.slice(0, 50), overrides || {}));
}));
app.post('/api/import/create', wrap(async (req, res) => {
  const drafts = req.body?.drafts || [];
  if (!drafts.length) throw Object.assign(new Error('Nothing to create'), { status: 400 });
  res.json(sync.runJob('import', async (progress) => {
    const results = [];
    for (const [i, d] of drafts.entries()) {
      progress(`Creating ${i + 1} of ${drafts.length}: ${d.title}`);
      try { results.push({ title: d.title, ok: true, ...(await listings.createListing(d)) }); }
      catch (e) {
        const msg = e.body?.errors ? e.body.errors.map((x) => `${x.field || ''} ${x.message || ''}`.trim()).join('; ') : e.message;
        results.push({ title: d.title, ok: false, error: msg });
        await log('error', 'listings', `Create "${d.title}" failed: ${msg}`);
      }
    }
    return { results, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }));
}));

// ---------- Whatnot products ----------
app.get('/api/products', wrap(async (req, res) => {
  const search = String(req.query.search || '').toLowerCase();
  const lim = Math.min(200, Number(req.query.limit) || 50), off = (Math.max(1, Number(req.query.page) || 1) - 1) * lim;
  const where = search ? `WHERE lower(p.title) LIKE $1 OR EXISTS (SELECT 1 FROM wn_variants x WHERE x.product_id=p.id AND lower(coalesce(x.sku,'')) LIKE $1)` : '';
  const params = search ? [`%${search}%`] : [];
  const { rows } = await q(`SELECT p.*, count(w.id)::int AS variants, sum(coalesce(w.wn_qty,0))::int AS qty,
      min(w.bin_price) AS min_bin, max(w.bin_price) AS max_bin, min(w.auction_price) AS min_auction,
      count(l.wn_variant_id)::int AS linked
      FROM wn_products p LEFT JOIN wn_variants w ON w.product_id=p.id LEFT JOIN links l ON l.wn_variant_id=w.id
      ${where} GROUP BY p.id ORDER BY p.title LIMIT ${lim} OFFSET ${off}`, params);
  const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n FROM wn_products p ${where}`, params);
  res.json({ rows, total: n });
}));
app.get('/api/products/:id', wrap(async (req, res) => {
  const p = await wn.getProduct(req.params.id);
  const category = p.category?.id ? await tax.categoryInfo(p.category.id) : null;
  const { rows: variants } = await q(`SELECT w.*, sv.sku AS shop_sku, sv.qty AS shop_qty, sv.stocked FROM wn_variants w
      LEFT JOIN links l ON l.wn_variant_id=w.id LEFT JOIN shop_variants sv ON sv.id=l.shop_variant_id WHERE w.product_id=$1 ORDER BY w.options`, [req.params.id]);
  const { rows: [local] } = await q('SELECT shopify_product_id, transaction_type, reserved_for_live FROM wn_products WHERE id=$1', [req.params.id]);
  res.json({ product: p, category, variants, local: local || {} });
}));
app.patch('/api/products/:id', wrap(async (req, res) => res.json(await listings.editProduct(req.params.id, req.body || {}))));
app.post('/api/products/:id/update-from-shopify', wrap(async (req, res) => res.json(await listings.updateFromShopify(req.params.id, req.body || {}))));
app.post('/api/products/bulk-edit', wrap(async (req, res) => {
  const { ids, changes } = req.body || {};
  if (!ids?.length) throw Object.assign(new Error('Select products first'), { status: 400 });
  res.json(await listings.bulkEditProducts(ids, changes || {}));
}));
app.post('/api/products/bulk-update-from-shopify', wrap(async (req, res) => {
  const { ids, prices } = req.body || {};
  if (!ids?.length) throw Object.assign(new Error('Select products first'), { status: 400 });
  res.json(sync.runJob('update', async (progress) => {
    const results = [];
    for (const [i, id] of ids.entries()) {
      progress(`Updating ${i + 1} of ${ids.length}`);
      try { results.push({ id, ok: true, ...(await listings.updateFromShopify(id, { prices: !!prices })) }); }
      catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    return { results, updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }));
}));
app.post('/api/products/delete', wrap(async (req, res) => {
  const { ids } = req.body || {};
  if (!ids?.length) throw Object.assign(new Error('Select products first'), { status: 400 });
  res.json(await listings.deleteProducts(ids));
}));

// ---------- orders & logs ----------
app.post('/api/orders/:id/tracking', wrap(async (req, res) => {
  const { carrier, tracking_code } = req.body || {};
  if (!carrier || !tracking_code) throw Object.assign(new Error('Carrier and tracking number are required'), { status: 400 });
  res.json(await sync.sendTracking(req.params.id, { carrier: sync.mapCarrier(carrier), tracking_code: String(tracking_code).trim() }));
}));
app.get('/api/orders', wrap(async (req, res) => {
  const { rows } = await q(`SELECT * FROM orders ORDER BY coalesce(wn_created_at, created_at) DESC LIMIT $1`, [Math.min(500, Number(req.query.limit) || 100)]);
  res.json(rows);
}));
app.post('/api/orders/:id/retry', wrap(async (req, res) => res.json(await sync.importOrder(req.params.id, { force: true }))));
app.get('/api/logs', wrap(async (req, res) => {
  const lvl = req.query.level;
  const { rows } = await q(`SELECT * FROM logs ${lvl ? 'WHERE level=$2' : ''} ORDER BY id DESC LIMIT $1`, lvl ? [200, lvl] : [200]);
  res.json(rows);
}));

// ---------- frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- scheduler ----------
let timer = null;
async function scheduleReconcile() {
  const s = await getSettings();
  if (timer) clearInterval(timer);
  const mins = Math.max(5, Number(s.reconcile_minutes) || 15);
  timer = setInterval(async () => {
    const cur = await getSettings();
    if (!cur.location_id || !process.env.WHATNOT_API_KEY) return;
    sync.runJob('sync', sync.fullSync);
  }, mins * 60_000);
}

await migrate();
await auth.bootstrapAdmin();
await scheduleReconcile();
tax.loadTaxonomy().catch((e) => console.error(e.message));
app.listen(PORT, () => console.log(`Whatnot ⇄ Shopify sync running on :${PORT}`));

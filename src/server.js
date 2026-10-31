import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q, getSettings, saveSettings, log, firstTime } from './db.js';
import * as shopify from './shopify.js';
import * as wn from './whatnot.js';
import * as sync from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('wns:' + PASSWORD + (process.env.WHATNOT_API_KEY || '')).digest('hex');
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

// ---------- auth ----------
app.use(express.json({ limit: '2mb' }));
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function readCookie(req, name) {
  const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return c ? decodeURIComponent(c.slice(name.length + 1)) : null;
}
function authed(req) {
  if (!PASSWORD) return true;
  const c = readCookie(req, 'wns');
  if (!c) return false;
  const [exp, sig] = c.split('.');
  return sig && sig === sign(exp) && Number(exp) > Date.now();
}
app.post('/api/login', (req, res) => {
  const ok = PASSWORD && typeof req.body?.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(PASSWORD).digest());
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `wns=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.setHeader('Set-Cookie', 'wns=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authed: authed(req), passwordSet: !!PASSWORD }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Login required' })));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e); res.status(e.status && e.status < 600 ? (e.status === 401 ? 502 : e.status) : 500).json({ error: e.message });
});

// ---------- status & settings ----------
app.get('/api/status', wrap(async (req, res) => {
  const s = await getSettings();
  const out = { settings: s, app_url: appUrl(req), env: {
    shopify: !!process.env.SHOPIFY_SHOP && !!(process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_CLIENT_ID),
    shopify_webhook_secret: !!(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET),
    whatnot: !!process.env.WHATNOT_API_KEY, whatnot_webhook_secret: !!process.env.WHATNOT_WEBHOOK_SECRET, password: !!PASSWORD,
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
  for (const k of ['match_by', 'push_enabled', 'orders_mode', 'reconcile_minutes', 'rounding', 'zero_unmatched']) if (b[k] !== undefined) patch[k] = b[k];
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

// ---------- orders & logs ----------
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
await scheduleReconcile();
app.listen(PORT, () => console.log(`Whatnot ⇄ Shopify sync running on :${PORT}`));

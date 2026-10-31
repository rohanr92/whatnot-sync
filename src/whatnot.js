import crypto from 'node:crypto';

const BASE = () => (process.env.WHATNOT_BASE_URL || 'https://api.whatnot.com/seller-api/rest/v2').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whatnot allows 10 req/s per seller per app. Serialize calls at ~8/s.
let chain = Promise.resolve();
let last = 0;
const MIN_GAP = 125;
function slot() {
  const p = chain.then(async () => {
    const wait = last + MIN_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  });
  chain = p.catch(() => {});
  return p;
}

export class WhatnotError extends Error {
  constructor(status, body) {
    super(`Whatnot ${status}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 600)}`);
    this.status = status; this.body = body;
  }
}

export async function api(method, path, body, attempt = 0) {
  const key = process.env.WHATNOT_API_KEY;
  if (!key) throw new Error('WHATNOT_API_KEY is not set');
  await slot();
  const res = await fetch(BASE() + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    const ra = Number(res.headers.get('retry-after'));
    const backoff = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 400;
    await sleep(ra > 0 ? ra * 1000 + 100 : backoff);
    return api(method, path, body, attempt + 1);
  }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  if (!res.ok && res.status !== 207) throw new WhatnotError(res.status, json);
  return json;
}

async function* paginate(path) {
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const qs = `limit=50&reverse=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const j = await api('GET', `${path}${sep}${qs}`);
    yield j.data || [];
    cursor = j.next_cursor || null;
  } while (cursor);
}

export const health = () => api('GET', '/products?limit=1');
export const listProducts = () => paginate('/products');
export const listVariants = (productId) => paginate(`/products/${productId}/variants`);
export const getMerchandising = (productId) => api('GET', `/merchandising/products/${productId}`);
export const merchandise = (productId, body) => api('POST', `/merchandising/products/${productId}`, body);
export const getOrder = (id) => api('GET', `/orders/${id}`);
export async function getOrderItems(id) {
  const all = []; for await (const page of paginate(`/orders/${id}/items`)) all.push(...page); return all;
}
export const recentOrders = () => api('GET', '/orders?limit=50&reverse=true');

// products
export const getProduct = (id) => api('GET', `/products/${id}`);
export const createProduct = (body) => api('POST', '/products', body);
export const updateProduct = (id, body) => api('PATCH', `/products/${id}`, body);
export const deleteProduct = (id) => api('DELETE', `/products/${id}`);
export async function allVariants(productId) {
  const all = []; for await (const page of listVariants(productId)) all.push(...page); return all;
}
export async function dimensionProfiles() {
  const all = []; for await (const page of paginate('/shipping/dimension_profiles')) all.push(...page); return all;
}

// shipments: send seller tracking for order items (needs write:shipments + own-label approval)
export const addTrackingCode = (carrier, orderItemIds, trackingCode) =>
  api('POST', '/shipments/add_tracking_code', { carrier, order_item_ids: orderItemIds.map(String), tracking_code: trackingCode });

// items: [{variant_id, quantity}] -> chunks of 10 (API limit)
export async function setInventory(items) {
  const results = [];
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10).map((it) => ({
      variant_id: it.variant_id, quantity: Math.max(0, Math.trunc(it.quantity)), idempotency_key: crypto.randomUUID(),
    }));
    const j = await api('POST', '/inventory/set', { items: chunk });
    results.push(...(j.results || []));
  }
  return results;
}

// variants: [{id, pricing:{...}}] for ONE product, chunks of 10
export async function patchVariants(productId, variants) {
  const out = { variants: [], errors: [] };
  for (let i = 0; i < variants.length; i += 10) {
    const j = await api('PATCH', `/products/${productId}/variants`, { variants: variants.slice(i, i + 10), allow_partial_updates: true });
    out.variants.push(...(j.variants || []));
    out.errors.push(...(j.errors || []));
  }
  return out;
}

// Standard Webhooks style verification (Whatnot docs: strip "wn_wh_" prefix, base64-decode key).
export function verifyWebhook(rawBody, headers) {
  const secret = process.env.WHATNOT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'WHATNOT_WEBHOOK_SECRET not set' };
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sigs = headers['webhook-signature'];
  if (!id || !ts || !sigs) return { ok: false, reason: 'missing headers' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, reason: 'timestamp too old' };
  let key = secret.replace(/^wn_wh_/, '').replace(/^whsec_/, '');
  const keyBuf = Buffer.from(key, 'base64');
  const expected = crypto.createHmac('sha256', keyBuf).update(`${id}.${ts}.`).update(rawBody).digest();
  for (const part of String(sigs).split(' ')) {
    const [ver, sig] = part.split(',');
    if (ver !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad signature' };
}

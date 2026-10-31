import { q, getSettings, log } from './db.js';
import * as shopify from './shopify.js';
import * as wn from './whatnot.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const money = (amount, currencyCode) => ({ shopMoney: { amount: Number(amount || 0).toFixed(2), currencyCode } });

// ---------- background job tracking (one at a time per name) ----------
export const jobs = {};
export function runJob(name, fn) {
  if (jobs[name]?.running) return jobs[name];
  const job = { name, running: true, started: new Date().toISOString(), progress: '', result: null, error: null };
  jobs[name] = job;
  fn((p) => { job.progress = p; })
    .then((r) => { job.result = r; })
    .catch((e) => { job.error = e.message; log('error', name, e.message); })
    .finally(() => { job.running = false; job.finished = new Date().toISOString(); });
  return job;
}

// ---------- catalog refresh ----------
async function upsertWnVariant(p, v) {
  const opts = (v.selected_options || []).map((o) => `${o.name}: ${o.value}`).join(' / ');
  await q(`INSERT INTO wn_variants(id,product_id,product_title,options,sku,external_id,bin_price,auction_price,currency,wn_qty,image,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT(id) DO UPDATE SET product_id=$2,product_title=$3,options=$4,sku=$5,external_id=$6,bin_price=$7,
      auction_price=$8,currency=$9,wn_qty=$10,image=$11,updated_at=now()`,
  [v.id, p.id, p.title, opts, v.sku || null, v.external_id || null,
    v.pricing?.buy_it_now?.price?.amount ?? null, v.pricing?.auction?.start_price?.amount ?? null,
    v.pricing?.buy_it_now?.price?.currency || v.pricing?.auction?.start_price?.currency || 'USD',
    v.inventory?.available_quantity ?? null, v.media?.[0]?.url || p.media?.[0]?.url || null]);
}

export async function refreshWhatnotProduct(p, { merch = true } = {}) {
  let tt = null, rfl = null;
  if (merch) {
    try { const m = await wn.getMerchandising(p.id); tt = m.transaction_type ?? null; rfl = m.reserved_for_live ?? null; } catch { /* optional */ }
  }
  await q(`INSERT INTO wn_products(id,title,url,image,transaction_type,reserved_for_live,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT(id) DO UPDATE SET title=$2,url=$3,image=$4,
      transaction_type=COALESCE($5,wn_products.transaction_type),reserved_for_live=COALESCE($6,wn_products.reserved_for_live),updated_at=now()`,
  [p.id, p.title, p.url || null, p.media?.[0]?.url || null, tt, rfl]);
  const seen = [];
  for await (const page of wn.listVariants(p.id)) for (const v of page) { await upsertWnVariant(p, v); seen.push(v.id); }
  await q('DELETE FROM wn_variants WHERE product_id=$1 AND NOT (id = ANY($2))', [p.id, seen]);
  return seen;
}

export async function refreshWhatnot(progress = () => {}) {
  const started = new Date();
  let n = 0, nv = 0;
  for await (const page of wn.listProducts()) {
    for (const p of page) { nv += (await refreshWhatnotProduct(p)).length; n++; progress(`Whatnot: ${n} products, ${nv} variants`); }
  }
  await q('DELETE FROM wn_variants WHERE updated_at < $1', [started]);
  await q('DELETE FROM wn_products WHERE updated_at < $1', [started]);
  return { products: n, variants: nv };
}

async function upsertShopVariant(v, level) {
  const qty = level ? (level.quantities?.[0]?.quantity ?? 0) : null;
  await q(`INSERT INTO shop_variants(id,product_title,title,sku,barcode,price,inventory_item_id,qty,stocked,product_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT(id) DO UPDATE SET product_title=$2,title=$3,sku=$4,barcode=$5,price=$6,inventory_item_id=$7,qty=$8,stocked=$9,product_id=$10,updated_at=now()`,
  [v.id, v.product?.title, v.title, v.sku || null, v.barcode || null, v.price ?? null,
    shopify.numId(v.inventoryItem?.id), qty, !!level, v.product?.id || null]);
}

export async function refreshShopify(progress = () => {}) {
  const s = await getSettings();
  if (!s.location_id) throw new Error('Pick a Shopify location in Settings first');
  const started = new Date();
  let n = 0;
  for await (const page of shopify.variantsAtLocation(s.location_id)) {
    for (const v of page) { await upsertShopVariant(v, v.inventoryItem?.inventoryLevel); n++; }
    progress(`Shopify: ${n} variants`);
  }
  await q('DELETE FROM shop_variants WHERE updated_at < $1', [started]);
  return { variants: n };
}

// ---------- matching ----------
export async function relink() {
  const s = await getSettings();
  const { rows: shop } = await q('SELECT id, sku, barcode FROM shop_variants');
  const byId = new Map(), bySku = new Map(), byBarcode = new Map();
  for (const r of shop) {
    byId.set(shopify.numId(r.id), r.id);
    if (r.sku) bySku.set(norm(r.sku), r.id);
    if (r.barcode) byBarcode.set(norm(r.barcode), r.id);
  }
  const { rows: wv } = await q(`SELECT w.id, w.sku, w.external_id, l.manual FROM wn_variants w LEFT JOIN links l ON l.wn_variant_id=w.id`);
  let matched = 0;
  for (const v of wv) {
    if (v.manual) { matched++; continue; }
    let target = null, type = null;
    const ext = String(v.external_id || '').split('/').pop().replace(/\D/g, '');
    const key = norm(v.sku);
    if (ext && byId.has(ext)) { target = byId.get(ext); type = 'shopify id'; }
    else if (key && s.match_by !== 'barcode' && bySku.has(key)) { target = bySku.get(key); type = 'sku'; }
    else if (key && s.match_by !== 'sku' && byBarcode.has(key)) { target = byBarcode.get(key); type = 'barcode'; }
    if (target) {
      matched++;
      await q(`INSERT INTO links(wn_variant_id,shop_variant_id,match_type,manual) VALUES($1,$2,$3,false)
        ON CONFLICT(wn_variant_id) DO UPDATE SET shop_variant_id=$2, match_type=$3`, [v.id, target, type]);
    } else {
      await q('DELETE FROM links WHERE wn_variant_id=$1 AND manual=false', [v.id]);
    }
  }
  await q('DELETE FROM links WHERE wn_variant_id NOT IN (SELECT id FROM wn_variants)');
  return { whatnot_variants: wv.length, matched, unmatched: wv.length - matched };
}

export async function setManualLink(wnVariantId, shopSkuOrId) {
  if (!shopSkuOrId) { await q('DELETE FROM links WHERE wn_variant_id=$1', [wnVariantId]); await relink(); return null; }
  const key = norm(shopSkuOrId);
  const { rows } = await q(`SELECT id FROM shop_variants WHERE lower(regexp_replace(coalesce(sku,''),'\\s','','g'))=$1
     OR lower(regexp_replace(coalesce(barcode,''),'\\s','','g'))=$1 OR id=$2 OR id=$3 LIMIT 1`,
  [key, shopSkuOrId, shopify.gid('ProductVariant', shopSkuOrId)]);
  if (!rows.length) throw new Error(`No Shopify variant with SKU/barcode/ID "${shopSkuOrId}"`);
  await q(`INSERT INTO links(wn_variant_id,shop_variant_id,match_type,manual) VALUES($1,$2,'manual',true)
    ON CONFLICT(wn_variant_id) DO UPDATE SET shop_variant_id=$2, match_type='manual', manual=true`, [wnVariantId, rows[0].id]);
  return rows[0].id;
}

// ---------- inventory: Shopify location -> Whatnot ----------
const desired = (row, buffer) => (row.stocked ? Math.max(0, (row.qty || 0) - (Number(buffer) || 0)) : 0);

export async function pushInventory({ wnIds = null, force = false, reason = 'manual' } = {}) {
  const s = await getSettings();
  const { rows } = await q(`SELECT w.id, w.wn_qty, w.sku, sv.qty, sv.stocked FROM wn_variants w
      JOIN links l ON l.wn_variant_id=w.id JOIN shop_variants sv ON sv.id=l.shop_variant_id
      ${wnIds ? 'WHERE w.id = ANY($1)' : ''}`, wnIds ? [wnIds] : []);
  const items = [];
  for (const r of rows) {
    const want = desired(r, s.buffer);
    if (force || r.wn_qty === null || r.wn_qty !== want) items.push({ variant_id: r.id, quantity: want, sku: r.sku });
  }
  if (s.zero_unmatched && !wnIds) {
    const { rows: un } = await q(`SELECT w.id, w.sku, w.wn_qty FROM wn_variants w LEFT JOIN links l ON l.wn_variant_id=w.id
       WHERE l.wn_variant_id IS NULL AND (w.wn_qty IS NULL OR w.wn_qty <> 0)`);
    for (const r of un) items.push({ variant_id: r.id, quantity: 0, sku: r.sku });
  }
  if (!items.length) return { checked: rows.length, pushed: 0, failed: 0 };
  const results = await wn.setInventory(items);
  let ok = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'applied' || typeof r.new_quantity === 'number') {
      ok++; await q('UPDATE wn_variants SET wn_qty=$2, last_pushed_at=now() WHERE id=$1', [r.variant_id, r.new_quantity]);
    } else { failed++; await log('warn', 'inventory', `Variant ${r.variant_id}: ${r.status} ${JSON.stringify(r.warnings || r.error || '')}`); }
  }
  const detail = items.slice(0, 8).map((i) => `${i.sku || i.variant_id}=${i.quantity}`).join(', ');
  await log('info', 'inventory', `Pushed ${ok}/${items.length} to Whatnot (${reason})${failed ? `, ${failed} failed` : ''}: ${detail}${items.length > 8 ? '…' : ''}`);
  return { checked: rows.length, pushed: ok, failed };
}

async function wnIdsForShop(shopVariantIds) {
  const { rows } = await q('SELECT wn_variant_id FROM links WHERE shop_variant_id = ANY($1)', [shopVariantIds]);
  return rows.map((r) => r.wn_variant_id);
}

export async function onShopifyInventory(topic, body) {
  const s = await getSettings();
  if (!s.location_id || String(body.location_id) !== shopify.numId(s.location_id)) return; // other location: ignore
  const itemId = String(body.inventory_item_id);
  if (topic === 'inventory_levels/disconnect') await q('UPDATE shop_variants SET stocked=false, qty=NULL WHERE inventory_item_id=$1', [itemId]);
  else await q('UPDATE shop_variants SET stocked=true, qty=$2 WHERE inventory_item_id=$1', [itemId, body.available ?? 0]);
  const { rows } = await q('SELECT id FROM shop_variants WHERE inventory_item_id=$1', [itemId]);
  if (!rows.length || !s.push_enabled) return;
  const ids = await wnIdsForShop(rows.map((r) => r.id));
  if (ids.length) await pushInventory({ wnIds: ids, reason: `Shopify ${topic}` });
}

export async function onShopifyProduct(body) {
  const s = await getSettings();
  const changed = []; const priceChanged = [];
  for (const v of body.variants || []) {
    const id = v.admin_graphql_api_id || shopify.gid('ProductVariant', v.id);
    const pid = body.admin_graphql_api_id || shopify.gid('Product', body.id);
    const { rows: [old] } = await q('SELECT price FROM shop_variants WHERE id=$1', [id]);
    if (old && v.price != null && Number(old.price) !== Number(v.price)) {
      priceChanged.push({ id, base: Number(s.price_source === 'compare_at' ? v.compare_at_price || v.price : v.price) });
    }
    const r = await q(`UPDATE shop_variants SET sku=$2, barcode=$3, price=$4, title=$5, product_title=$6, inventory_item_id=$7, product_id=$8 WHERE id=$1`,
      [id, v.sku || null, v.barcode || null, v.price ?? null, v.title, body.title, String(v.inventory_item_id), pid]);
    if (!r.rowCount && s.location_id) {
      const [lvl] = await shopify.levelsFor([v.inventory_item_id], s.location_id);
      await q(`INSERT INTO shop_variants(id,product_title,title,sku,barcode,price,inventory_item_id,qty,stocked,product_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(id) DO NOTHING`, [id, body.title, v.title, v.sku || null, v.barcode || null, v.price ?? null, String(v.inventory_item_id), lvl?.qty ?? null, !!lvl?.stocked, pid]);
    }
    changed.push(id);
  }
  await relink();
  if (s.push_enabled && changed.length) {
    const ids = await wnIdsForShop(changed);
    if (ids.length) await pushInventory({ wnIds: ids, reason: 'Shopify product update' });
  }
  // Shopify price changed -> Whatnot Buy it now price (whole dollars, markup applied, auction price kept)
  if (s.price_sync !== false && priceChanged.length) {
    const { rows } = await q(`SELECT w.id, w.auction_price, l.shop_variant_id FROM wn_variants w JOIN links l ON l.wn_variant_id=w.id
        WHERE l.shop_variant_id = ANY($1)`, [priceChanged.map((x) => x.id)]);
    const ups = rows.map((r) => {
      const base = priceChanged.find((x) => x.id === r.shop_variant_id).base;
      const bin = Math.round(base * (1 + (Number(s.price_markup_pct) || 0) / 100));
      return bin > 0 ? { id: r.id, bin, auction: r.auction_price != null ? Number(r.auction_price) : null } : null;
    }).filter(Boolean);
    if (ups.length) {
      const res = await applyPrices(ups);
      await log(res.errors.length ? 'warn' : 'info', 'prices', `Shopify price change "${body.title}" → Whatnot Buy it now updated on ${res.updated} sizes`);
    }
  }
}

// ---------- Whatnot product webhooks ----------
export async function onWhatnotProduct(type, data) {
  const id = data?.id || data?.product_id;
  if (!id) return;
  if (type === 'products.deleted') {
    await q('DELETE FROM wn_variants WHERE product_id=$1', [id]);
    await q('DELETE FROM wn_products WHERE id=$1', [id]);
    await relink(); return;
  }
  const p = data.title ? data : { id, title: null };
  const ids = await refreshWhatnotProduct(p, { merch: type === 'products.created' });
  await relink();
  const s = await getSettings();
  if (s.push_enabled && ids.length) await pushInventory({ wnIds: ids, reason: `Whatnot ${type}` });
}

// ---------- prices ----------
function roundPrice(x, mode) {
  if (!(x > 0)) return 0;
  if (mode === '99') return Math.max(0.99, Math.floor(x) + 0.99);
  if (mode === 'whole') return Math.round(x);
  return Math.round(x * 100) / 100;
}

export function computePrice(row, field, mode, value, rounding) {
  const cur = Number(field === 'bin' ? row.bin_price : row.auction_price) || 0;
  const shopPrice = Number(row.shop_price) || 0;
  const v = Number(value) || 0;
  let x;
  switch (mode) {
    case 'set': x = v; break;
    case 'inc_pct': x = cur * (1 + v / 100); break;
    case 'dec_pct': x = cur * (1 - v / 100); break;
    case 'inc_amt': x = cur + v; break;
    case 'dec_amt': x = cur - v; break;
    case 'shopify': x = shopPrice; break;
    case 'shopify_pct': x = shopPrice * (1 + v / 100); break;
    case 'copy_bin': x = Number(row.bin_price) || 0; break;
    case 'copy_bin_pct': x = (Number(row.bin_price) || 0) * (1 + v / 100); break;
    default: throw new Error('Unknown price mode ' + mode);
  }
  return roundPrice(x, rounding);
}

// updates: [{id, bin?:number, auction?:number}]
export async function applyPrices(updates) {
  if (!updates.length) return { updated: 0, errors: [] };
  const { rows } = await q('SELECT id, product_id, currency FROM wn_variants WHERE id = ANY($1)', [updates.map((u) => u.id)]);
  const meta = new Map(rows.map((r) => [r.id, r]));
  const byProduct = new Map();
  for (const u of updates) {
    const m = meta.get(u.id); if (!m) continue;
    const cur = m.currency || 'USD';
    const pricing = {};
    if (u.bin != null) pricing.buy_it_now = { price: { amount: Math.round(Number(u.bin)).toFixed(2), currency: cur } };
    if (u.auction != null) pricing.auction = { start_price: { amount: Math.round(Number(u.auction)).toFixed(2), currency: cur } };
    if (!Object.keys(pricing).length) continue;
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push({ id: u.id, pricing });
  }
  let updated = 0; const errors = [];
  for (const [pid, vars] of byProduct) {
    try {
      const r = await wn.patchVariants(pid, vars);
      for (const v of r.variants) {
        updated++;
        await q('UPDATE wn_variants SET bin_price=$2, auction_price=$3 WHERE id=$1',
          [v.id, v.pricing?.buy_it_now?.price?.amount ?? null, v.pricing?.auction?.start_price?.amount ?? null]);
      }
      for (const e of r.errors) errors.push(`${e.id}: ${e.message || e.code}`);
    } catch (e) { errors.push(`product ${pid}: ${e.message}`); }
  }
  await log(errors.length ? 'warn' : 'info', 'prices', `Updated ${updated} variant prices${errors.length ? `; ${errors.length} errors: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  return { updated, errors };
}

export async function bulkPrice({ ids, field, mode, value, rounding }) {
  const { rows } = await q(`SELECT w.id, w.bin_price, w.auction_price, sv.price AS shop_price FROM wn_variants w
      LEFT JOIN links l ON l.wn_variant_id=w.id LEFT JOIN shop_variants sv ON sv.id=l.shop_variant_id WHERE w.id = ANY($1)`, [ids]);
  const updates = rows.map((r) => ({ id: r.id, [field === 'bin' ? 'bin' : 'auction']: computePrice(r, field, mode, value, rounding) }))
    .filter((u) => (u.bin ?? u.auction) > 0);
  const skipped = rows.length - updates.length;
  const res = await applyPrices(updates);
  return { ...res, skipped };
}

export async function bulkMerch({ productIds, transaction_type, reserve_for_live }) {
  const body = {};
  if (transaction_type) body.transaction_type = transaction_type;
  if (typeof reserve_for_live === 'boolean') body.reserve_for_live = reserve_for_live;
  let ok = 0; const errors = [];
  for (const id of productIds) {
    try {
      const r = await wn.merchandise(id, body);
      await q('UPDATE wn_products SET transaction_type=$2, reserved_for_live=$3 WHERE id=$1', [id, r.transaction_type ?? null, r.reserved_for_live ?? null]);
      ok++;
    } catch (e) {
      const errs = e.body?.errors ? e.body.errors.map((x) => x.field || x.message || JSON.stringify(x)).join(', ') : e.message;
      errors.push(`${id}: ${errs}`);
    }
  }
  await log(errors.length ? 'warn' : 'info', 'merchandising', `Sale format updated on ${ok}/${productIds.length} products${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  return { updated: ok, errors };
}

// ---------- orders: Whatnot -> Shopify ----------
export async function importOrder(orderId, { force = false } = {}) {
  const s = await getSettings();
  if (s.orders_mode === 'off' && !force) return { skipped: 'orders sync is off' };
  if (!s.location_id) throw new Error('No Shopify location selected');
  const { rows: [existing] } = await q('SELECT * FROM orders WHERE wn_order_id=$1', [orderId]);
  if (existing && ['imported', 'deducted', 'cancelled'].includes(existing.status) && !force) return { skipped: 'already imported' };

  const order = await wn.getOrder(orderId);
  if (s.orders_since && !force && new Date(order.created_at) < new Date(s.orders_since)) return { skipped: 'older than start date' };
  if (/cancel/i.test(order.status || '')) {
    await q(`INSERT INTO orders(wn_order_id,status,wn_status,wn_created_at) VALUES($1,'skipped',$2,$3)
      ON CONFLICT(wn_order_id) DO UPDATE SET wn_status=$2, updated_at=now()`, [orderId, order.status, order.created_at]);
    return { skipped: 'cancelled on Whatnot' };
  }
  const items = await wn.getOrderItems(orderId);
  const a = order.amounts || {};
  const currency = a.total?.currency || a.subtotal?.currency || 'USD';
  const buyer = order.buyer?.username || order.buyer?.display_name || '';

  const resolved = [];
  for (const it of items) {
    const { rows: [m] } = await q(`SELECT sv.id, sv.inventory_item_id FROM links l JOIN shop_variants sv ON sv.id=l.shop_variant_id
       WHERE l.wn_variant_id=$1`, [it.variant_id]);
    resolved.push({
      wn_item_id: it.id, variant_id: it.variant_id, sku: it.purchased_item?.sku || null, title: it.purchased_item?.title || 'Whatnot item',
      quantity: it.quantity || 1, unit_price: it.unit_price?.amount ?? '0', shop_variant_id: m?.id || null, inventory_item_id: m?.inventory_item_id || null,
    });
  }
  const unmatched = resolved.filter((r) => !r.shop_variant_id);
  await q(`INSERT INTO orders(wn_order_id,status,wn_status,buyer,total,items,wn_created_at) VALUES($1,'processing',$2,$3,$4,$5,$6)
    ON CONFLICT(wn_order_id) DO UPDATE SET status=CASE WHEN orders.shopify_order_id IS NULL THEN 'processing' ELSE orders.status END,
      wn_status=$2,buyer=$3,total=$4,items=$5,error=NULL,updated_at=now()`,
  [orderId, order.status, buyer, `${a.total?.amount ?? ''} ${currency}`, JSON.stringify(resolved), order.created_at]);

  const { rows: [row] } = await q('SELECT * FROM orders WHERE wn_order_id=$1', [orderId]);
  try {
    let shopOrder = row.shopify_order_id ? { id: row.shopify_order_id, name: row.shopify_order_name } : null;
    if (s.orders_mode !== 'deduct_only' && !shopOrder) {
      const sub = Number(a.subtotal?.amount || 0), tax = Number(a.tax?.amount || 0), ship = Number(a.shipping?.amount || 0);
      const disc = Number(a.applied_discount?.amount?.amount || 0);
      const input = {
        currency,
        lineItems: resolved.map((r) => r.shop_variant_id
          ? { variantId: r.shop_variant_id, quantity: r.quantity, priceSet: money(r.unit_price, currency), requiresShipping: true, sku: r.sku || undefined }
          : { title: `${r.title}${r.sku ? ` (${r.sku})` : ''}`, quantity: r.quantity, priceSet: money(r.unit_price, currency), requiresShipping: true }),
        financialStatus: 'PAID',
        sourceName: 'whatnot',
        sourceIdentifier: String(orderId),
        tags: ['Whatnot', `WN-${orderId}`],
        note: `Whatnot order ${orderId}${buyer ? ` — buyer @${buyer}` : ''}${order.url ? `\n${order.url}` : ''}${order.transaction_type ? `\nType: ${order.transaction_type}` : ''}`,
        transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Whatnot', amountSet: money(a.total?.amount ?? sub + ship + tax - disc, currency) }],
      };
      if (ship > 0) input.shippingLines = [{ title: 'Whatnot Shipping', priceSet: money(ship, currency) }];
      if (tax > 0) input.taxLines = [{ title: 'Whatnot sales tax', rate: sub > 0 ? +(tax / sub).toFixed(4) : 0, priceSet: money(tax, currency), channelLiable: true }];
      if (disc > 0) input.discountCode = { itemFixedDiscountCode: { code: 'WHATNOT', amountSet: money(disc, currency) } };
      shopOrder = await shopify.createOrder(input);
      await q(`UPDATE orders SET shopify_order_id=$2, shopify_order_name=$3, status='order_created', updated_at=now() WHERE wn_order_id=$1`, [orderId, shopOrder.id, shopOrder.name]);
    }
    if (!row.deducted) {
      const changes = resolved.filter((r) => r.inventory_item_id).map((r) => ({ inventory_item_id: r.inventory_item_id, delta: -r.quantity }));
      await shopify.adjustAvailable(changes, s.location_id, `wn-${orderId}-deduct`, 'correction', shopOrder?.id);
      await q('UPDATE orders SET deducted=true WHERE wn_order_id=$1', [orderId]);
      // refresh qty for these items and push back so other Whatnot listings of the same SKU stay right
      await refreshLevelsAndPush(changes.map((c) => c.inventory_item_id), `Whatnot order ${orderId}`);
    }
    const status = s.orders_mode === 'deduct_only' ? 'deducted' : 'imported';
    const warn = unmatched.length ? `No Shopify match for: ${unmatched.map((u) => u.sku || u.title).join(', ')}` : null;
    await q('UPDATE orders SET status=$2, error=$3, updated_at=now() WHERE wn_order_id=$1', [orderId, status, warn]);
    await log(warn ? 'warn' : 'info', 'orders', `Whatnot order ${orderId} → ${shopOrder?.name || 'inventory deducted'}${warn ? ` (${warn})` : ''}`);
    return { status, shopify_order: shopOrder?.name || null, warning: warn };
  } catch (e) {
    await q(`UPDATE orders SET status='error', error=$2, updated_at=now() WHERE wn_order_id=$1`, [orderId, e.message]);
    await log('error', 'orders', `Whatnot order ${orderId}: ${e.message}`);
    throw e;
  }
}

async function refreshLevelsAndPush(inventoryItemIds, reason) {
  const s = await getSettings();
  if (!inventoryItemIds.length) return;
  const lv = await shopify.levelsFor(inventoryItemIds, s.location_id);
  for (const l of lv) await q('UPDATE shop_variants SET qty=$2, stocked=$3 WHERE inventory_item_id=$1', [shopify.numId(l.inventory_item_id), l.qty, l.stocked]);
  const { rows } = await q('SELECT id FROM shop_variants WHERE inventory_item_id = ANY($1)', [inventoryItemIds.map(String)]);
  const ids = await wnIdsForShop(rows.map((r) => r.id));
  if (ids.length && s.push_enabled) await pushInventory({ wnIds: ids, reason });
}

export async function cancelImported(orderId, wnStatus) {
  const s = await getSettings();
  const { rows: [row] } = await q('SELECT * FROM orders WHERE wn_order_id=$1', [orderId]);
  if (!row) {
    await q(`INSERT INTO orders(wn_order_id,status,wn_status) VALUES($1,'skipped',$2) ON CONFLICT DO NOTHING`, [orderId, wnStatus]);
    return;
  }
  if (row.status === 'cancelled') return;
  if (row.shopify_order_id) {
    try { await shopify.cancelOrder(row.shopify_order_id, `Cancelled on Whatnot (${wnStatus})`); }
    catch (e) { await log('warn', 'orders', `Cancel ${row.shopify_order_name}: ${e.message}`); }
  }
  if (row.deducted) {
    const changes = (row.items || []).filter((r) => r.inventory_item_id).map((r) => ({ inventory_item_id: r.inventory_item_id, delta: r.quantity }));
    await shopify.adjustAvailable(changes, s.location_id, `wn-${orderId}-restock`, 'restock', row.shopify_order_id || undefined);
    await refreshLevelsAndPush(changes.map((c) => c.inventory_item_id), `Whatnot order ${orderId} cancelled`);
  }
  await q(`UPDATE orders SET status='cancelled', wn_status=$2, updated_at=now() WHERE wn_order_id=$1`, [orderId, wnStatus]);
  await log('info', 'orders', `Whatnot order ${orderId} cancelled → ${row.shopify_order_name || ''} cancelled${row.deducted ? ', stock returned' : ''}`);
}

// ---------- fulfillment: Shopify tracking -> Whatnot ----------
export function mapCarrier(company) {
  const c = String(company || '').toLowerCase();
  if (c.includes('usps')) return 'usps';
  if (/\bups\b|^ups/.test(c)) return 'ups';
  if (c.includes('fedex')) return 'fedex';
  if (c.includes('dhl')) return 'dhl';
  if (c.includes('canada post')) return 'canada_post';
  return c.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'usps';
}

export async function sendTracking(orderId, { carrier, tracking_code, item_ids = null, source = 'manual' }) {
  const { rows: [row] } = await q('SELECT * FROM orders WHERE wn_order_id=$1', [orderId]);
  if (!row) throw new Error('Order not found');
  const ids = (item_ids?.length ? item_ids : (row.items || []).map((i) => i.wn_item_id)).filter(Boolean).map(String);
  if (!ids.length) throw new Error('No Whatnot order items to attach tracking to');
  const tracking = row.tracking || {};
  const key = `${carrier}:${tracking_code}`;
  if (tracking[key] && ids.every((i) => tracking[key].items.includes(i))) return { skipped: 'already sent' };
  try {
    await wn.addTrackingCode(carrier, ids, tracking_code);
    tracking[key] = { carrier, tracking_code, items: ids, sent_at: new Date().toISOString(), source };
    await q(`UPDATE orders SET tracking=$2, tracking_status='sent', tracking_error=NULL, updated_at=now() WHERE wn_order_id=$1`, [orderId, JSON.stringify(tracking)]);
    await log('info', 'tracking', `Whatnot order ${orderId}: sent ${carrier} ${tracking_code} (${ids.length} item${ids.length > 1 ? 's' : ''})`);
    return { sent: true, items: ids.length };
  } catch (e) {
    const msg = e.status === 503 ? 'Whatnot says seller tracking codes are unavailable for this account (own-label shipping not enabled)'
      : e.status === 409 ? 'Whatnot refused this tracking code for these items (already shipped/dropped off, or a different buyer/address)' : e.message;
    await q(`UPDATE orders SET tracking_status='error', tracking_error=$2, updated_at=now() WHERE wn_order_id=$1`, [orderId, msg]);
    await log('error', 'tracking', `Whatnot order ${orderId}: ${msg}`);
    throw new Error(msg);
  }
}

export async function onShopifyFulfillment(body) {
  const s = await getSettings();
  if (!s.tracking_enabled) return;
  if (['cancelled', 'error', 'failure'].includes(body.status)) return;
  const orderGid = shopify.gid('Order', body.order_id);
  const { rows: [row] } = await q('SELECT * FROM orders WHERE shopify_order_id=$1', [orderGid]);
  if (!row) return; // not a Whatnot order
  const code = body.tracking_number || body.tracking_numbers?.[0];
  if (!code) { await log('info', 'tracking', `Shopify fulfilled ${row.shopify_order_name} without a tracking number — nothing sent`); return; }
  const items = row.items || [];
  const ids = new Set();
  for (const li of body.line_items || []) {
    const vg = li.variant_id ? shopify.gid('ProductVariant', li.variant_id) : null;
    const hit = items.find((i) => vg && i.shop_variant_id === vg) || items.find((i) => !i.shop_variant_id && li.title && li.title.startsWith(i.title));
    if (hit) ids.add(String(hit.wn_item_id));
  }
  if (!ids.size) items.forEach((i) => ids.add(String(i.wn_item_id)));
  try { await sendTracking(row.wn_order_id, { carrier: mapCarrier(body.tracking_company), tracking_code: code, item_ids: [...ids], source: 'shopify' }); }
  catch { /* logged */ }
}

export async function onWhatnotEvent(evt) {
  const { type, data } = evt;
  if (type === 'orders.created' || type === 'orders.updated') {
    const id = data?.id; if (!id) return;
    if (/cancel/i.test(data.status || '') || data.cancelled_at) return cancelImported(id, data.status || 'cancelled');
    if (type === 'orders.created') return importOrder(id);
    const { rows: [row] } = await q('SELECT status FROM orders WHERE wn_order_id=$1', [id]);
    if (!row || row.status === 'error') return importOrder(id); // created event missed or failed earlier
    await q('UPDATE orders SET wn_status=$2, updated_at=now() WHERE wn_order_id=$1', [id, data.status]);
    return;
  }
  if (type?.startsWith('products.')) return onWhatnotProduct(type, data);
}

// Safety net: webhooks aren't a complete log, so poll recent orders too.
export async function pollOrders() {
  const s = await getSettings();
  if (s.orders_mode === 'off') return { checked: 0 };
  const j = await wn.recentOrders();
  let imported = 0;
  for (const o of j.data || []) {
    if (s.orders_since && new Date(o.created_at) < new Date(s.orders_since)) continue;
    const { rows: [row] } = await q('SELECT status FROM orders WHERE wn_order_id=$1', [o.id]);
    if (/cancel/i.test(o.status || '')) { if (row && row.status !== 'cancelled' && row.status !== 'skipped') await cancelImported(o.id, o.status); continue; }
    if (!row) { try { await importOrder(o.id); imported++; } catch { /* logged */ } }
  }
  return { checked: (j.data || []).length, imported };
}

export async function fullSync(progress = () => {}) {
  const shop = await refreshShopify(progress);
  const wv = await refreshWhatnot(progress);
  progress('Matching SKUs…');
  const link = await relink();
  const s = await getSettings();
  let push = { skipped: 'push disabled' };
  if (s.push_enabled) { progress('Pushing inventory…'); push = await pushInventory({ reason: 'full sync' }); }
  let orders = null;
  try { orders = await pollOrders(); } catch (e) { orders = { error: e.message }; }
  await log('info', 'sync', `Full sync: Shopify ${shop.variants} variants, Whatnot ${wv.variants} variants, matched ${link.matched}, pushed ${push.pushed ?? 0}`);
  return { shopify: shop, whatnot: wv, link, push, orders };
}

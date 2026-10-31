// Shopify -> Whatnot listings: import, auto-map, create, update, edit, delete
import { q, getSettings, saveSettings, log } from './db.js';
import * as shopify from './shopify.js';
import * as wn from './whatnot.js';
import * as tax from './taxonomy.js';
import * as sync from './sync.js';

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const lc = (s) => String(s ?? '').toLowerCase().trim();

export function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
}

export function priceFor(variant, s) {
  const base = Number(s.price_source === 'compare_at' ? variant.compareAtPrice || variant.price : variant.price) || 0;
  const bin = base > 0 ? r2(base * (1 + (Number(s.price_markup_pct) || 0) / 100)) : null;
  const auction = bin && s.auction_start_pct != null && s.auction_start_pct !== '' ? Math.max(1, Math.round(bin * Number(s.auction_start_pct) / 100)) : null;
  return { bin, auction };
}

// Real options only (Shopify uses "Title: Default Title" for products without options)
function realOptions(p) {
  return (p.options || []).filter((o) => !(o.name === 'Title' && o.values.length === 1 && o.values[0] === 'Default Title')).slice(0, 3);
}

export async function onWhatnot(shopifyProductIds) {
  if (!shopifyProductIds.length) return {};
  const { rows } = await q(`SELECT DISTINCT sv.product_id, w.product_id AS wn_product_id FROM shop_variants sv
      JOIN links l ON l.shop_variant_id=sv.id JOIN wn_variants w ON w.id=l.wn_variant_id WHERE sv.product_id = ANY($1)
    UNION SELECT shopify_product_id, id FROM wn_products WHERE shopify_product_id = ANY($1)`, [shopifyProductIds]);
  return Object.fromEntries(rows.map((r) => [r.product_id, r.wn_product_id]));
}

// Build an editable draft from a Shopify product, with everything auto-mapped
export async function buildDraft(p, s, overrides = {}) {
  const categoryId = overrides.category_id || (await tax.guessCategory(p, s));
  const auto = categoryId ? await tax.autoAttributes(categoryId, p, s) : { attributes: [], missing: ['Category'], info: null };
  const options = realOptions(p);
  const variants = p.variants.map((v) => {
    const { bin, auction } = priceFor(v, s);
    return {
      shopify_variant_id: v.id, title: v.title, sku: v.sku, barcode: v.barcode, inventory_item_id: v.inventory_item_id,
      options: Object.fromEntries((v.selectedOptions || []).filter((o) => options.some((x) => x.name === o.name)).map((o) => [o.name, o.value])),
      qty: v.stocked ? Math.max(0, (v.qty || 0) - (Number(s.buffer) || 0)) : 0, location_qty: v.qty, stocked: v.stocked, shopify_price: v.price,
      bin, auction,
    };
  });
  return {
    shopify_product_id: p.id, product_type: p.productType, vendor: p.vendor,
    title: (p.title || '').slice(0, 200), description: htmlToText(p.descriptionHtml).slice(0, 5000),
    category_id: categoryId, category_path: auto.info?.path || null,
    attributes: auto.attributes, missing: auto.missing, category_attributes: auto.info?.attributes || [],
    media: p.images.slice(0, 10), options: options.map((o) => ({ name: o.name, values: o.values })),
    variants, sale_format: overrides.sale_format || s.default_sale_format, publish: overrides.publish ?? !!s.auto_publish,
  };
}

export async function previewImport(shopifyProductIds, overrides = {}) {
  const s = await getSettings();
  if (!s.location_id) throw new Error('Pick a Shopify location in Settings first');
  const drafts = [];
  for (const id of shopifyProductIds) {
    const p = await shopify.getProduct(id, s.location_id);
    if (p) drafts.push(await buildDraft(p, s, overrides));
  }
  const on = await onWhatnot(drafts.map((d) => d.shopify_product_id));
  drafts.forEach((d) => { d.existing_wn_product_id = on[d.shopify_product_id] || null; });
  return drafts;
}

async function dimensionProfile(s) {
  if (s.dimension_profile_id) {
    const list = await wn.dimensionProfiles().catch(() => []);
    const p = list.find((x) => String(x.id) === String(s.dimension_profile_id));
    if (p) return { id: p.id, name: p.name, dimensions: p.dimensions, weight: p.weight };
  }
  const d = s.default_dims || {};
  return {
    name: 'Default box',
    dimensions: { length: Number(d.length) || 12, width: Number(d.width) || 8, height: Number(d.height) || 5, unit: d.unit || 'inch' },
    weight: { value: Number(d.weight) || 32, unit: d.weight_unit || 'ounce' },
  };
}

function matchVariant(wv, draftVariants) {
  if (draftVariants.length === 1) return draftVariants[0];
  const sel = Object.fromEntries((wv.selected_options || []).map((o) => [lc(o.name), lc(o.value)]));
  return draftVariants.find((dv) => Object.entries(dv.options).every(([k, v]) => sel[lc(k)] === lc(v)))
    || draftVariants.find((dv) => dv.sku && lc(dv.sku) === lc(wv.sku));
}

function validateDraft(d) {
  const errs = [];
  if (!d.title?.trim()) errs.push('title');
  if (!d.category_id) errs.push('category');
  if (!d.variants?.length) errs.push('variants');
  const priced = d.sale_format === 'auction' ? d.variants.every((v) => Number(v.auction) > 0) : d.variants.every((v) => Number(v.bin) > 0);
  if (!priced) errs.push(d.sale_format === 'auction' ? 'auction price on every variant' : 'buy-it-now price on every variant');
  return errs;
}

// Create one Whatnot product from a (possibly edited) draft
export async function createListing(d) {
  const s = await getSettings();
  const errs = validateDraft(d);
  if (errs.length) throw new Error(`Missing: ${errs.join(', ')}`);
  const warnings = [];
  const body = {
    title: d.title.trim(), description: d.description || null, category: { id: String(d.category_id) },
    attributes: (d.attributes || []).filter((a) => a.value !== '' && a.value != null).map((a) => ({ id: String(a.id), value: String(a.value) })),
    media: (d.media || []).filter((m) => m.url).map((m) => ({ url: m.url, alt: m.alt || d.title })),
    options: (d.options || []).map((o) => ({ name: o.name, values: o.values })),
    external_id: shopify.numId(d.shopify_product_id),
    dimension_profile: await dimensionProfile(s),
  };
  const created = await wn.createProduct(body);
  const pid = created.id;
  // variants are auto-created from options: give each its SKU, Shopify id and prices
  const wvs = await wn.allVariants(pid);
  const patches = []; const qtys = [];
  for (const wv of wvs) {
    const dv = matchVariant(wv, d.variants);
    if (!dv) { warnings.push(`No Shopify variant for ${wv.selected_options?.map((o) => o.value).join('/')}`); continue; }
    const cur = 'USD';
    const pricing = {};
    if (Number(dv.bin) > 0) pricing.buy_it_now = { price: { amount: Math.round(Number(dv.bin)).toFixed(2), currency: cur } };
    if (Number(dv.auction) > 0) pricing.auction = { start_price: { amount: Math.round(Number(dv.auction)).toFixed(2), currency: cur } };
    patches.push({ id: wv.id, sku: dv.sku || undefined, external_id: shopify.numId(dv.shopify_variant_id), pricing });
    qtys.push({ variant_id: wv.id, quantity: dv.qty || 0, sku: dv.sku });
  }
  let pr;
  try { pr = await wn.patchVariants(pid, patches); }
  catch (e) { await wn.deleteProduct(pid).catch(() => {}); throw e; } // undo, so a retry doesn't make a duplicate
  pr.errors.forEach((e) => warnings.push(`Variant ${e.id}: ${e.message || e.code}`));
  if (qtys.length) await wn.setInventory(qtys);

  // keep local cache in step
  for (const v of d.variants) {
    await q(`INSERT INTO shop_variants(id,product_title,title,sku,barcode,price,inventory_item_id,qty,stocked,product_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET product_id=$10`,
    [v.shopify_variant_id, d.title, v.title, v.sku || null, v.barcode || null, v.shopify_price ?? null, v.inventory_item_id, v.stocked ? (v.location_qty ?? v.qty ?? 0) : null, !!v.stocked, d.shopify_product_id]);
  }
  await sync.refreshWhatnotProduct({ ...created, title: created.title || d.title }, { merch: false });
  const info = await tax.categoryInfo(d.category_id);
  await q('UPDATE wn_products SET shopify_product_id=$2, category_id=$3, category_label=$4 WHERE id=$1', [pid, d.shopify_product_id, String(d.category_id), info?.path || null]);
  await sync.relink();
  await sync.pushInventory({ wnIds: wvs.map((v) => v.id), reason: 'new listing' });

  // remember category choice for this product type
  if (d.product_type) {
    const map = { ...(s.category_map || {}), [lc(d.product_type)]: Number(d.category_id) };
    await saveSettings({ category_map: map });
  }

  // sale format / publish
  let merch = null;
  if (d.sale_format === 'auction' || d.publish) {
    try {
      const m = d.sale_format === 'auction' ? { transaction_type: 'auction' } : { transaction_type: 'buy_it_now', reserve_for_live: false };
      merch = await wn.merchandise(pid, m);
      await q('UPDATE wn_products SET transaction_type=$2, reserved_for_live=$3 WHERE id=$1', [pid, merch.transaction_type, merch.reserved_for_live]);
    } catch (e) {
      const why = e.body?.errors ? e.body.errors.map((x) => x.field || x.message || JSON.stringify(x)).join(', ') : e.message;
      warnings.push(`Created as draft — not published: ${why}`);
    }
  }
  await log(warnings.length ? 'warn' : 'info', 'listings', `Created Whatnot product ${pid} "${d.title}" (${wvs.length} variants)${warnings.length ? ' — ' + warnings.join('; ') : ''}`);
  return { product_id: pid, url: created.url, variants: wvs.length, published: !!merch && d.sale_format !== 'auction', warnings };
}

// Re-send Shopify content to an existing Whatnot product
export async function updateFromShopify(wnProductId, { prices = false, content = true } = {}) {
  const s = await getSettings();
  let { rows: [row] } = await q('SELECT shopify_product_id FROM wn_products WHERE id=$1', [wnProductId]);
  let spid = row?.shopify_product_id;
  if (!spid) {
    const { rows: [x] } = await q(`SELECT sv.product_id FROM wn_variants w JOIN links l ON l.wn_variant_id=w.id
        JOIN shop_variants sv ON sv.id=l.shop_variant_id WHERE w.product_id=$1 AND sv.product_id IS NOT NULL LIMIT 1`, [wnProductId]);
    spid = x?.product_id;
  }
  if (!spid) throw new Error('This Whatnot product is not linked to a Shopify product yet');
  const p = await shopify.getProduct(spid, s.location_id);
  if (!p) throw new Error('Shopify product not found');
  const current = await wn.getProduct(wnProductId);
  const d = await buildDraft(p, s, { category_id: current.category?.id });
  const warnings = [];
  if (content) {
    const patch = { title: d.title, description: d.description, media: d.media.map((m) => ({ url: m.url, alt: m.alt || d.title })) };
    // add new option values (e.g. a new size added in Shopify)
    const curOpts = Object.fromEntries((current.options || []).map((o) => [lc(o.name), (o.values || []).map(lc)]));
    const changed = d.options.some((o) => o.values.some((v) => !(curOpts[lc(o.name)] || []).includes(lc(v))));
    if (changed) patch.options = d.options.map((o) => {
      const cur = (current.options || []).find((x) => lc(x.name) === lc(o.name));
      return { name: o.name, values: [...new Set([...(cur?.values || []), ...o.values])] };
    });
    await wn.updateProduct(wnProductId, patch);
  }
  const wvs = await wn.allVariants(wnProductId);
  const patches = [];
  for (const wv of wvs) {
    const dv = matchVariant(wv, d.variants);
    if (!dv) continue;
    const v = { id: wv.id, sku: dv.sku || undefined, external_id: shopify.numId(dv.shopify_variant_id) };
    if (prices || (!wv.pricing?.buy_it_now && !wv.pricing?.auction)) {
      v.pricing = {};
      if (dv.bin) v.pricing.buy_it_now = { price: { amount: Math.round(dv.bin).toFixed(2), currency: 'USD' } };
      if (dv.auction) v.pricing.auction = { start_price: { amount: Math.round(dv.auction).toFixed(2), currency: 'USD' } };
    }
    patches.push(v);
  }
  const pr = await wn.patchVariants(wnProductId, patches);
  pr.errors.forEach((e) => warnings.push(`Variant ${e.id}: ${e.message || e.code}`));
  await q('UPDATE wn_products SET shopify_product_id=$2 WHERE id=$1', [wnProductId, spid]);
  await sync.refreshWhatnotProduct({ id: wnProductId, title: d.title, url: current.url, media: current.media }, { merch: false });
  await sync.relink();
  await sync.pushInventory({ wnIds: wvs.map((v) => v.id), reason: 'update from Shopify' });
  await log(warnings.length ? 'warn' : 'info', 'listings', `Updated Whatnot product ${wnProductId} from Shopify${warnings.length ? ' — ' + warnings.join('; ') : ''}`);
  return { updated: true, variants: wvs.length, warnings };
}

// Edit Whatnot product fields directly
export async function editProduct(id, patch) {
  const body = {};
  for (const k of ['title', 'description']) if (patch[k] !== undefined) body[k] = patch[k];
  if (patch.category_id) body.category = { id: String(patch.category_id) };
  if (Array.isArray(patch.attributes)) body.attributes = patch.attributes.filter((a) => a.value !== '' && a.value != null).map((a) => ({ id: String(a.id), value: String(a.value) }));
  if (Array.isArray(patch.media)) body.media = patch.media.filter((m) => m.url).map((m) => ({ url: m.url, alt: m.alt || '' }));
  if (Array.isArray(patch.options)) body.options = patch.options;
  const r = await wn.updateProduct(id, body);
  const info = patch.category_id ? await tax.categoryInfo(patch.category_id) : null;
  await q(`UPDATE wn_products SET title=COALESCE($2,title), category_id=COALESCE($3,category_id), category_label=COALESCE($4,category_label) WHERE id=$1`,
    [id, body.title ?? null, patch.category_id ? String(patch.category_id) : null, info?.path ?? null]);
  if (body.title) await q('UPDATE wn_variants SET product_title=$2 WHERE product_id=$1', [id, body.title]);
  await log('info', 'listings', `Edited Whatnot product ${id}: ${Object.keys(body).join(', ')}`);
  return r;
}

// Bulk edit: category / one attribute / title find-replace, prefix, suffix / description append
export async function bulkEditProducts(ids, ch) {
  let ok = 0; const errors = [];
  for (const id of ids) {
    try {
      const cur = await wn.getProduct(id);
      const patch = {};
      let title = cur.title;
      if (ch.find) title = title.split(ch.find).join(ch.replace || '');
      if (ch.prefix) title = `${ch.prefix}${title}`;
      if (ch.suffix) title = `${title}${ch.suffix}`;
      if (title !== cur.title) patch.title = title.slice(0, 200);
      if (ch.description_append) patch.description = `${cur.description || ''}\n\n${ch.description_append}`.trim();
      if (ch.category_id) patch.category_id = ch.category_id;
      if (ch.attribute_id && ch.attribute_value !== undefined) {
        const attrs = (cur.attributes || []).map((a) => ({ id: String(a.id), value: a.value }));
        const i = attrs.findIndex((a) => a.id === String(ch.attribute_id));
        if (i >= 0) attrs[i].value = ch.attribute_value; else attrs.push({ id: String(ch.attribute_id), value: ch.attribute_value });
        patch.attributes = attrs;
      }
      if (Object.keys(patch).length) await editProduct(id, patch);
      ok++;
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  return { updated: ok, errors };
}

export async function deleteProducts(ids) {
  let ok = 0; const errors = [];
  for (const id of ids) {
    try {
      await wn.deleteProduct(id);
      await q('DELETE FROM wn_variants WHERE product_id=$1', [id]);
      await q('DELETE FROM wn_products WHERE id=$1', [id]);
      ok++;
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  await sync.relink();
  await log(errors.length ? 'warn' : 'info', 'listings', `Deleted ${ok}/${ids.length} Whatnot products`);
  return { deleted: ok, errors };
}

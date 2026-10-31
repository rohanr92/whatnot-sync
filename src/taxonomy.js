// Whatnot product taxonomy (categories + attributes), from Whatnot's public GitHub repo.
import { q } from './db.js';

const URL = process.env.WHATNOT_TAXONOMY_URL || 'https://raw.githubusercontent.com/Whatnot-Inc/product-taxonomy/main/data/taxonomy.json';
let tax = null; // { version, cats: Map, attrs: Map, list: [] }

function build(d) {
  const cats = new Map(d.categories.map((c) => [c.id, c]));
  const attrs = new Map(d.attributes.map((a) => [a.id, a]));
  const pathOf = (c) => { const p = []; let x = c; while (x) { p.unshift(x.label); x = cats.get(x.parent_id); } return p.join(' > '); };
  const list = d.categories.filter((c) => c.allows_inventory).map((c) => ({ id: c.id, label: c.label, path: pathOf(c) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { version: d.version, cats, attrs, list };
}

export async function loadTaxonomy(force = false) {
  if (tax && !force) return tax;
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    tax = build(d);
    await q(`INSERT INTO kv(key,value,updated_at) VALUES('taxonomy',$1,now()) ON CONFLICT(key) DO UPDATE SET value=$1, updated_at=now()`, [JSON.stringify(d)]);
  } catch (e) {
    const { rows: [r] } = await q(`SELECT value FROM kv WHERE key='taxonomy'`);
    if (!r) throw new Error(`Could not load Whatnot categories: ${e.message}`);
    tax = build(r.value);
  }
  return tax;
}

export async function categories() { return (await loadTaxonomy()).list; }

export async function categoryInfo(id) {
  const t = await loadTaxonomy();
  const c = t.cats.get(Number(id));
  if (!c) return null;
  const path = t.list.find((x) => x.id === c.id)?.path || c.label;
  const attributes = (c.attributes || []).map((x) => {
    const a = t.attrs.get(x.id) || {};
    return { id: x.id, key: a.key, label: a.label, type: a.type, required: !!x.is_required, custom: !!a.allows_custom_values, values: a.values || [] };
  });
  return { id: c.id, label: c.label, path, allows_inventory: !!c.allows_inventory, attributes };
}

// Pick a category for a Shopify product: saved map by product type -> keyword guess -> default
export async function guessCategory(product, settings) {
  const type = String(product.productType || '').toLowerCase().trim();
  if (type && settings.category_map?.[type]) return Number(settings.category_map[type]);
  const list = await categories();
  const text = `${product.productType || ''} ${product.title || ''}`.toLowerCase();
  const rules = [
    [/sandal|shoe|heel|flat|loafer|boot|slipper|sneaker|mule|clog|wedge|espadrille/, /women's shoes/i],
    [/dress|top|blouse|skirt|pant|jean|jumpsuit|sweater|cardigan|coat|jacket/, /other women's fashion/i],
    [/bag|purse|tote|clutch/, /fashion bags/i],
  ];
  for (const [re, cat] of rules) if (re.test(text)) { const hit = list.find((c) => cat.test(c.path)); if (hit) return hit.id; }
  return settings.default_category_id ? Number(settings.default_category_id) : null;
}

const pick = (values, want) => {
  if (!want) return null;
  const w = String(want).toLowerCase().trim();
  return values.find((v) => v.toLowerCase() === w) || values.find((v) => v.toLowerCase().includes(w) || w.includes(v.toLowerCase())) || null;
};

// Auto-fill category attributes from Shopify product data. Returns [{id, value}] plus list of missing required ones.
export async function autoAttributes(categoryId, product, settings) {
  const info = await categoryInfo(categoryId);
  if (!info) return { attributes: [], missing: [], info: null };
  const opt = (name) => product.options?.find((o) => o.name.toLowerCase().includes(name))?.values || [];
  const colors = opt('color').concat(opt('colour'));
  const sizes = opt('size');
  const firstVariant = product.variants?.[0] || {};
  const out = []; const missing = [];
  for (const a of info.attributes) {
    const k = (a.key || '').toLowerCase();
    let v = null;
    if (k.endsWith('brand')) v = product.vendor;
    else if (k.endsWith('color')) v = colors[0] || guessColor(product.title, a.values);
    else if (k.endsWith('size')) {
      const s = sizes[0];
      v = s && (a.values.includes(`${s}W`) && /women/.test(k) ? `${s}W` : pick(a.values, s) || s);
    } else if (k.endsWith('msrp')) v = firstVariant.compareAtPrice || firstVariant.price;
    else if (k.endsWith('condition')) v = pick(a.values, settings.default_condition) || pick(a.values, 'New With Tags') || pick(a.values, 'New');
    else if (k.endsWith('.type') || k.endsWith('clothing_type')) v = pick(a.values, product.productType) || pick(a.values, singular(product.productType)) || guessType(product.title, a.values);
    if (v != null && v !== '' && a.type === 'ENUM' && !a.custom) v = pick(a.values, v);
    if (v != null && v !== '') out.push({ id: a.id, value: String(v) });
    else if (a.required) missing.push(a.label);
  }
  return { attributes: out, missing, info };
}

function singular(s) { return String(s || '').replace(/s$/i, ''); }
function guessType(title, values) {
  const t = String(title || '').toLowerCase();
  return values.find((v) => t.includes(v.toLowerCase().replace(/s$/, ''))) || null;
}
function guessColor(title, values) {
  const t = String(title || '').toLowerCase();
  return values.find((v) => new RegExp(`\\b${v.toLowerCase()}\\b`).test(t)) || null;
}

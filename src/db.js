import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const ssl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) || process.env.PGSSL === 'off'
  ? false : { rejectUnauthorized: false };

export const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  await q(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB);
  CREATE TABLE IF NOT EXISTS wn_products (
    id TEXT PRIMARY KEY, title TEXT, url TEXT, image TEXT,
    transaction_type TEXT, reserved_for_live BOOLEAN, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS wn_variants (
    id TEXT PRIMARY KEY, product_id TEXT, product_title TEXT, options TEXT,
    sku TEXT, external_id TEXT, bin_price NUMERIC, auction_price NUMERIC, currency TEXT,
    wn_qty INT, image TEXT, last_pushed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS shop_variants (
    id TEXT PRIMARY KEY, product_title TEXT, title TEXT, sku TEXT, barcode TEXT,
    price NUMERIC, inventory_item_id TEXT, qty INT, stocked BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT now());
  CREATE INDEX IF NOT EXISTS shop_variants_inv ON shop_variants(inventory_item_id);
  CREATE TABLE IF NOT EXISTS links (
    wn_variant_id TEXT PRIMARY KEY, shop_variant_id TEXT, match_type TEXT, manual BOOLEAN DEFAULT false);
  CREATE INDEX IF NOT EXISTS links_shop ON links(shop_variant_id);
  CREATE TABLE IF NOT EXISTS orders (
    wn_order_id TEXT PRIMARY KEY, status TEXT, wn_status TEXT, buyer TEXT, total TEXT,
    shopify_order_id TEXT, shopify_order_name TEXT, items JSONB, error TEXT, deducted BOOLEAN DEFAULT false,
    wn_created_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS logs (id BIGSERIAL PRIMARY KEY, level TEXT, area TEXT, message TEXT, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'staff', created_at TIMESTAMPTZ DEFAULT now(), last_login TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ DEFAULT now());
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking JSONB;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_status TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_error TEXT;
  ALTER TABLE wn_products ADD COLUMN IF NOT EXISTS shopify_product_id TEXT;
  ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS product_id TEXT;
  ALTER TABLE wn_products ADD COLUMN IF NOT EXISTS category_id TEXT;
  ALTER TABLE wn_products ADD COLUMN IF NOT EXISTS category_label TEXT;
  `);
}

export const DEFAULT_SETTINGS = {
  location_id: null,          // gid://shopify/Location/123
  location_name: null,
  match_by: 'sku',            // sku | barcode | both
  buffer: 0,                  // keep this many units back from Whatnot
  push_enabled: true,         // Shopify -> Whatnot inventory
  orders_mode: 'create_order',// off | create_order | deduct_only
  orders_since: null,         // only import Whatnot orders created after this
  reconcile_minutes: 15,
  rounding: 'none',
  zero_unmatched: false,     // set Whatnot qty to 0 for variants with no Shopify match
  tracking_enabled: true,     // Shopify fulfillment -> Whatnot tracking code
  price_sync: true,           // Shopify price change -> Whatnot Buy it now price (auction untouched)
  // ---- listing defaults (Shopify -> new Whatnot products) ----
  default_category_id: null,
  category_map: {},           // { "shopify product type (lowercase)": whatnot category id }
  dimension_profile_id: null, // seller dimension profile on Whatnot (optional)
  default_dims: { length: 12, width: 8, height: 5, unit: 'inch', weight: 32, weight_unit: 'ounce' },
  default_condition: 'New With Tags',
  price_source: 'price',      // price | compare_at
  price_markup_pct: 0,        // Whatnot BIN = Shopify price * (1 + markup%)
  auction_start_pct: null,    // e.g. 50 => auction start = 50% of BIN; null = no auction price
  default_sale_format: 'buy_it_now', // buy_it_now | auction
  auto_publish: false,        // publish to profile shop after create
};

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', [k, JSON.stringify(v)]);
  }
  return getSettings();
}

export async function log(level, area, message) {
  const line = `[${level}] ${area}: ${message}`;
  level === 'error' ? console.error(line) : console.log(line);
  try {
    await q('INSERT INTO logs(level,area,message) VALUES($1,$2,$3)', [level, area, String(message).slice(0, 2000)]);
    if (Math.random() < 0.02) await q(`DELETE FROM logs WHERE created_at < now() - interval '14 days'`);
  } catch { /* ignore */ }
}

// Returns true the first time an event id is seen (dedupe webhook retries).
export async function firstTime(id, source) {
  const r = await q('INSERT INTO events(id,source) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, source]);
  if (Math.random() < 0.02) await q(`DELETE FROM events WHERE created_at < now() - interval '7 days'`);
  return r.rowCount === 1;
}

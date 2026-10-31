import crypto from 'node:crypto';

const VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';
const shopDomain = () => {
  const s = (process.env.SHOPIFY_SHOP || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) throw new Error('SHOPIFY_SHOP is not set');
  return s.includes('.') ? s : `${s}.myshopify.com`;
};
const base = () => process.env.SHOPIFY_BASE_URL || `https://${shopDomain()}`; // override only for tests

let cached = { token: null, exp: 0 };

// Supports both a fixed admin token (shpat_...) and Dev Dashboard apps (client credentials grant).
async function token() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set SHOPIFY_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  const res = await fetch(`${base()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Shopify token error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  cached = { token: j.access_token, exp: Date.now() + ((j.expires_in || 86399) - 300) * 1000 };
  return cached.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(`${base()}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) { await sleep(1000 * 2 ** attempt); return gql(query, variables, attempt + 1); }
  }
  if (res.status === 401 && !process.env.SHOPIFY_ACCESS_TOKEN && attempt === 0) {
    cached = { token: null, exp: 0 }; return gql(query, variables, 1);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
  if (j.errors?.length) {
    const throttled = j.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 6) { await sleep(1500 * (attempt + 1)); return gql(query, variables, attempt + 1); }
    throw new Error(`Shopify GraphQL: ${j.errors.map((e) => e.message).join('; ')}`);
  }
  return j.data;
}

export const numId = (gid) => String(gid || '').split('/').pop();
export const gid = (type, id) => String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`;

export async function shopInfo() {
  const d = await gql('{ shop { name myshopifyDomain currencyCode } }');
  return d.shop;
}

export async function locations() {
  const d = await gql(`{ locations(first: 100, includeInactive: false) { nodes { id name isActive fulfillsOnlineOrders address { city } } } }`);
  return d.locations.nodes;
}

// All variants with available qty at one location. inventoryLevel is null when the item isn't stocked there.
export async function* variantsAtLocation(locationId) {
  let after = null;
  do {
    const d = await gql(`query($after:String,$loc:ID!){
      productVariants(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id title sku barcode price product { title }
          inventoryItem { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }
      } }`, { after, loc: locationId });
    yield d.productVariants.nodes;
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
}

export async function levelsFor(inventoryItemIds, locationId) {
  if (!inventoryItemIds.length) return [];
  const d = await gql(`query($ids:[ID!]!,$loc:ID!){ nodes(ids:$ids){ ... on InventoryItem { id
      inventoryLevel(locationId:$loc){ quantities(names:["available"]){ name quantity } } } } }`,
  { ids: inventoryItemIds.map((i) => gid('InventoryItem', i)), loc: locationId });
  return d.nodes.filter(Boolean).map((n) => ({
    inventory_item_id: n.id,
    stocked: !!n.inventoryLevel,
    qty: n.inventoryLevel ? (n.inventoryLevel.quantities[0]?.quantity ?? 0) : null,
  }));
}

export async function adjustAvailable(changes, locationId, idempotencyKey, reason = 'correction', ref) {
  if (!changes.length) return;
  const d = await gql(`mutation($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: "${idempotencyKey}") {
        userErrors { field message } } }`, {
    input: {
      name: 'available', reason, referenceDocumentUri: ref || undefined,
      changes: changes.map((c) => ({ inventoryItemId: gid('InventoryItem', c.inventory_item_id), locationId, delta: c.delta, changeFromQuantity: null })),
    },
  });
  const errs = d.inventoryAdjustQuantities.userErrors;
  if (errs.length) throw new Error('Inventory adjust: ' + errs.map((e) => e.message).join('; '));
}

export async function createOrder(order) {
  const d = await gql(`mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }`,
  { order, options: { inventoryBehaviour: 'BYPASS', sendReceipt: false, sendFulfillmentReceipt: false } });
  const errs = d.orderCreate.userErrors;
  if (errs.length) throw new Error('Order create: ' + errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; '));
  return d.orderCreate.order;
}

export async function cancelOrder(orderId, note) {
  const d = await gql(`mutation($id: ID!, $note: String) {
      orderCancel(orderId: $id, reason: CUSTOMER, restock: false, notifyCustomer: false, staffNote: $note) {
        orderCancelUserErrors { message } } }`, { id: orderId, note });
  const errs = d.orderCancel.orderCancelUserErrors;
  if (errs.length) throw new Error('Order cancel: ' + errs.map((e) => e.message).join('; '));
}

export const WEBHOOK_TOPICS = [
  'INVENTORY_LEVELS_UPDATE', 'INVENTORY_LEVELS_CONNECT', 'INVENTORY_LEVELS_DISCONNECT', 'PRODUCTS_UPDATE',
];

export async function registerWebhooks(appUrl) {
  const uri = `${appUrl.replace(/\/$/, '')}/webhooks/shopify`;
  const existing = await gql(`{ webhookSubscriptions(first: 100) { nodes { id topic uri } } }`);
  const results = [];
  for (const topic of WEBHOOK_TOPICS) {
    const found = existing.webhookSubscriptions.nodes.find((w) => w.topic === topic);
    if (found && found.uri === uri) { results.push({ topic, status: 'exists' }); continue; }
    if (found) await gql(`mutation($id:ID!){ webhookSubscriptionDelete(id:$id){ userErrors{message} } }`, { id: found.id });
    const d = await gql(`mutation($topic: WebhookSubscriptionTopic!, $uri: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
          webhookSubscription { id } userErrors { message } } }`, { topic, uri });
    const errs = d.webhookSubscriptionCreate.userErrors;
    results.push({ topic, status: errs.length ? 'error: ' + errs.map((e) => e.message).join('; ') : 'created' });
  }
  return results;
}

export function verifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, 'base64');
  return given.length === digest.length && crypto.timingSafeEqual(digest, given);
}

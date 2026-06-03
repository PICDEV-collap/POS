const DEFAULT_STORE_ID = 1;

function parseStoreIds(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof value === 'string') {
    return value.replace(/[{}]/g, '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  return [];
}

function requestedStoreId(req) {
  const raw = req.headers['x-pos-store-id'] || req.query?.store_id || req.body?.store_id || req.user?.store_id || DEFAULT_STORE_ID;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STORE_ID;
}

function resolveStoreId(req) {
  const storeId = requestedStoreId(req);
  const role = req.user?.role;
  if (role === 'super_admin') return storeId;

  const allowed = parseStoreIds(req.user?.allowed_store_ids);
  const fallback = Number(req.user?.store_id || DEFAULT_STORE_ID);
  const effectiveAllowed = allowed.length ? allowed : [fallback];
  if (!effectiveAllowed.includes(storeId)) {
    const err = new Error('store access forbidden');
    err.status = 403;
    throw err;
  }
  return storeId;
}

function storePredicate(req, alias, params) {
  const storeId = resolveStoreId(req);
  params.push(storeId);
  return `${alias}.store_id = $${params.length}`;
}

module.exports = {
  DEFAULT_STORE_ID,
  parseStoreIds,
  requestedStoreId,
  resolveStoreId,
  storePredicate,
};

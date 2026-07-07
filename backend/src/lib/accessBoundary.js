function firstHeaderValue(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').split(',')[0].trim();
}

function normalizeIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function clientIp(req) {
  // Use the IP Express derives from the configured `trust proxy` depth, NOT the
  // raw X-Forwarded-For header. The leftmost header value is client-supplied
  // and spoofable; trusting it would let a remote client forge a private/LAN
  // address and defeat the LAN-only admin gate. req.ip only honours the
  // forwarded chain up to the trusted hop count, so it fails closed.
  return normalizeIp(req.ip || req.socket?.remoteAddress || '');
}

function isLoopbackIp(ip) {
  const value = normalizeIp(ip).toLowerCase();
  return value === 'localhost'
    || value === '::1'
    || value === '0:0:0:0:0:0:0:1'
    || /^127\./.test(value);
}

function isPrivateLanIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return false;
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  const m = value.match(/^172\.(\d{1,2})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]*:/i.test(value)) return true;
  if (/^fe80:/i.test(value)) return true;
  return false;
}

function hostName(value) {
  const raw = firstHeaderValue(value).toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/^\[/, '').replace(/\]$/, '').split(':')[0];
  }
}

function isLocalHostName(value) {
  const host = hostName(value);
  if (!host) return true;
  return host === 'localhost'
    || host === '::1'
    || /^127\./.test(host)
    || isPrivateLanIp(host);
}

function trustedTunnelHosts() {
  return String(process.env.ADMIN_CONTROL_TUNNEL_HOSTS || '')
    .split(',')
    .map((h) => hostName(h))
    .filter(Boolean);
}

function requestHost(req) {
  return hostName(firstHeaderValue(req.headers['x-forwarded-host']))
    || hostName(firstHeaderValue(req.headers.host));
}

function isTrustedTunnelRequest(req) {
  const allowed = trustedTunnelHosts();
  if (!allowed.length) return false;
  const host = requestHost(req);
  if (!host) return false;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isLocalControlRequest(req) {
  if (isTrustedTunnelRequest(req)) return true;
  const ip = clientIp(req);
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const origin = firstHeaderValue(req.headers.origin);
  const referer = firstHeaderValue(req.headers.referer);
  if (forwardedHost && !isLocalHostName(forwardedHost)) return false;
  if (origin && !isLocalHostName(origin)) return false;
  if (referer && !isLocalHostName(referer)) return false;
  return isLoopbackIp(ip) || isPrivateLanIp(ip);
}

function adminControlLanOnlyEnabled() {
  return String(process.env.ADMIN_CONTROL_LAN_ONLY || 'true').toLowerCase() !== 'false';
}

function normalizedPath(req) {
  const raw = String(req.originalUrl || req.url || '').split('?')[0] || '';
  return raw.replace(/\/+$/, '') || '/';
}

function isAdminControlPath(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = normalizedPath(req);

  if (path.startsWith('/api/accounting')) return true;
  if (path.startsWith('/api/stores')) return true;
  if (path.startsWith('/api/users')) return true;
  if (path.startsWith('/api/settings') && method !== 'GET') return true;

  if (path.startsWith('/api/tables')) {
    // Reading table state is operational; table/QR management is LAN-only.
    return method !== 'GET';
  }

  if (path.startsWith('/api/categories')) {
    // Public/category reads are safe; menu structure changes stay on LAN.
    return path === '/api/categories/all' || method !== 'GET';
  }

  if (path.startsWith('/api/products')) {
    // Cashier barcode lookup and menu reads can be used remotely. Product
    // catalog/stock administration remains a local control action.
    if (method === 'GET' && /^\/api\/products\/barcode\//.test(path)) return false;
    if (method === 'GET' && /^\/api\/products\/\d+\/barcode\/label\.svg$/.test(path)) return false;
    if (method === 'GET' && path === '/api/products') return false;
    return path === '/api/products/admin' || method !== 'GET';
  }

  if (path.startsWith('/api/print')) {
    // Payload generation, order printing, claim/complete, health checks and
    // station reads are operational. Station config and dead-job admin actions
    // must stay in the server LAN.
    if (/^\/api\/print\/stations\/[^/]+$/.test(path) && method !== 'GET') return true;
    if (/^\/api\/print\/jobs\/[^/]+\/retry$/.test(path)) return true;
    return false;
  }

  return false;
}

function parsePermissions(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function hasPermission(req, permission) {
  return parsePermissions(req.user?.permissions).includes(permission);
}

function parseStoreIds(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof value === 'string') {
    return value.replace(/[{}]/g, '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  return [];
}

function isMobileStoreAdmin(req) {
  if (req.user?.role !== 'admin') return false;
  if (!hasPermission(req, 'mobile_admin') && !hasPermission(req, 'store_admin')) return false;
  const stores = parseStoreIds(req.user?.allowed_store_ids);
  return stores.length > 0;
}

function isMobileStoreAdminAllowedControlPath(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = normalizedPath(req);

  if (path.startsWith('/api/accounting')) return false;
  if (path.startsWith('/api/users')) return true;

  if (path.startsWith('/api/stores')) {
    // Remote store admins may discover/select their assigned stores and edit
    // their own store metadata, but cannot create/delete branches remotely.
    return method === 'GET' || method === 'PUT';
  }

  if (path.startsWith('/api/settings')) return method !== 'GET';
  if (path.startsWith('/api/tables')) return method !== 'GET';
  if (path.startsWith('/api/categories')) return true;

  if (path.startsWith('/api/products')) {
    if (method === 'GET') return true;
    return method === 'POST' || method === 'PUT' || method === 'DELETE';
  }

  if (path.startsWith('/api/print')) {
    // Keep physical printer station configuration and dead-job operations on
    // the server LAN. Operational print/test/payload endpoints stay available.
    if (/^\/api\/print\/stations\/[^/]+$/.test(path) && method !== 'GET') return false;
    if (/^\/api\/print\/jobs\/[^/]+\/retry$/.test(path)) return false;
    return true;
  }

  return false;
}

module.exports = {
  adminControlLanOnlyEnabled,
  clientIp,
  isMobileStoreAdmin,
  isMobileStoreAdminAllowedControlPath,
  isAdminControlPath,
  isLocalControlRequest,
  isTrustedTunnelRequest,
  isLocalHostName,
  isLoopbackIp,
  isPrivateLanIp,
  trustedTunnelHosts,
};

// mDNS / Bonjour service advertisement.
// Client discovery flow:
//   1. (LAN) browse `_pos_v2._tcp.local` via bonsoir/multicast_dns/avahi.
//   2. (Web)  fall back to GET /api/discovery/info on a known/typed-in URL.

const os = require('os');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'pos_v2';
const APP_VERSION = require('../package.json').version || '0.1.0';

let _bonjour = null;
let _service = null;

function localIPv4Addresses() {
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const a of iface || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function advertise(port) {
  if (_bonjour) return _service;
  try {
    _bonjour = new Bonjour();
    _service = _bonjour.publish({
      name: process.env.BONJOUR_NAME || `POS V2 — ${os.hostname()}`,
      type: SERVICE_TYPE,
      protocol: 'tcp',
      port,
      txt: {
        version: APP_VERSION,
        api: '/api',
        socketio: 'on',
      },
    });
    _service.on('up', () => {
      console.log(`[mDNS] advertising _${SERVICE_TYPE}._tcp on port ${port} as "${_service.name}"`);
    });
    _service.on('error', (e) => {
      console.error('[mDNS] service error:', e.message);
    });
  } catch (e) {
    console.error('[mDNS] failed to advertise:', e.message);
  }
  return _service;
}

function stop() {
  if (_service) { try { _service.stop(); } catch {} _service = null; }
  if (_bonjour) { try { _bonjour.destroy(); } catch {} _bonjour = null; }
}

function info(port) {
  // Public-facing URL for remote access (Caddy domain or ngrok tunnel). Set in backend `.env`:
  //   PUBLIC_BASE_URL=https://pos.example.com
  //   PUBLIC_BASE_URL=https://abc123.ngrok-free.app
  // When QR ordering is configured as WiFi/LAN-only, admin/staff screens should
  // prefer their LAN origin for QR codes and use this only for remote admin access.
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || null;
  return {
    service: SERVICE_TYPE,
    name: process.env.BONJOUR_NAME || `POS V2 — ${os.hostname()}`,
    hostname: os.hostname(),
    version: APP_VERSION,
    port,
    addresses: localIPv4Addresses(),
    public_base_url: publicBaseUrl,
    api_base_paths: {
      api: '/api',
      auth: '/api/auth/login',
      menu: '/api/public/menu',
    },
  };
}

module.exports = { advertise, stop, info, localIPv4Addresses, SERVICE_TYPE };

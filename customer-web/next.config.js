/** @type {import('next').NextConfig} */
const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  env: {
    // When deployed behind ngrok / a single-port reverse proxy, set this to ''
    // (empty) so the browser uses same-origin URLs and Next.js rewrites take over.
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000',
  },
  // Proxy backend traffic when same-origin mode is used (ngrok / production reverse proxy).
  // Note: Next.js rewrites do NOT proxy WebSockets in dev mode. For Socket.io behind
  // a single-port tunnel, use Caddy/Nginx as the front (or ngrok with WS upgrade).
  async rewrites() {
    return [
      { source: '/api/:path*',     destination: `${BACKEND_INTERNAL}/api/:path*` },
      { source: '/uploads/:path*', destination: `${BACKEND_INTERNAL}/uploads/:path*` },
      { source: '/socket.io/:path*', destination: `${BACKEND_INTERNAL}/socket.io/:path*` },
    ];
  },
};

module.exports = nextConfig;

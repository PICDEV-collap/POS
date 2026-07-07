/** @type {import('next').NextConfig} */
const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Socket.io polls `/socket.io/` (trailing slash). With the default
  // trailing-slash redirect Next answers that XHR long-poll with a 308 to
  // `/socket.io`, which the socket.io client can't follow — the connection
  // never establishes and realtime (order + call sounds) silently falls back
  // to slow polling. Disabling the redirect lets the catch-all route handler
  // under app/socket.io/ proxy the transport to the backend.
  skipTrailingSlashRedirect: true,
  env: {
    // When deployed behind ngrok / a single-port reverse proxy, set this to ''
    // (empty) so the browser uses same-origin URLs and Next.js rewrites take over.
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000',
  },
  // Proxy backend traffic when same-origin mode is used (ngrok / production
  // reverse proxy). /socket.io is handled by the route handler in
  // app/socket.io/[[...slug]] (rewrites can't proxy its trailing-slash poll).
  async rewrites() {
    return [
      { source: '/api/:path*',     destination: `${BACKEND_INTERNAL}/api/:path*` },
      { source: '/uploads/:path*', destination: `${BACKEND_INTERNAL}/uploads/:path*` },
    ];
  },
};

module.exports = nextConfig;

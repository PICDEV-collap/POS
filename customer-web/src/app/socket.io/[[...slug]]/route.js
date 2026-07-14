export const dynamic = 'force-dynamic';

// Proxy the Socket.io transport (polling) to the backend. This is an OPTIONAL
// catch-all so it matches `/socket.io`, `/socket.io/` (the trailing-slash form
// the client actually polls) and any `/socket.io/<sid>` subpath — combined
// with `skipTrailingSlashRedirect` in next.config.js so the long-poll isn't
// 308-redirected. WebSocket upgrades can't pass through a route handler; the
// client falls back to polling, which is enough for realtime events.

const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

function proxyHeaders(request) {
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  const cookie = request.headers.get('cookie');
  if (contentType) headers.set('content-type', contentType);
  if (cookie) headers.set('cookie', cookie);
  headers.set('x-forwarded-host', request.headers.get('host') || '');
  headers.set('x-forwarded-proto', request.nextUrl?.protocol?.replace(':', '') || 'https');
  return headers;
}

function responseHeaders(upstream) {
  const headers = new Headers();
  for (const key of ['content-type', 'cache-control']) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('cache-control', 'no-store');
  return headers;
}

async function proxySocketIo(request, context) {
  const slug = (context?.params?.slug || []).join('/');
  const target = new URL(`/socket.io/${slug}`, BACKEND_INTERNAL);
  target.search = request.nextUrl.search;
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method,
    headers: proxyHeaders(request),
    body,
    cache: 'no-store',
    redirect: 'manual',
    duplex: 'half',
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

export async function GET(request, context) {
  return proxySocketIo(request, context);
}

export async function POST(request, context) {
  return proxySocketIo(request, context);
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

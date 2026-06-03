export const dynamic = 'force-dynamic';

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

async function proxySocketIo(request) {
  const target = new URL('/socket.io/', BACKEND_INTERNAL);
  target.search = request.nextUrl.search;
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(target, {
    method,
    headers: proxyHeaders(request),
    body,
    cache: 'no-store',
    redirect: 'manual',
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

export async function GET(request) {
  return proxySocketIo(request);
}

export async function POST(request) {
  return proxySocketIo(request);
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

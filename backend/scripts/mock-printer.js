// Tiny TCP server that listens on PRINTER_PORT and dumps incoming bytes.
// Use it to verify ESC/POS output without a real thermal printer:
//   1) Set PRINTER_HOST=127.0.0.1 in .env (or env), keep PRINTER_PORT=9100
//   2) Run:  node scripts/mock-printer.js
//   3) Trigger any /api/print/* endpoint
//
// Output: hex dump + best-effort decoded text (TIS-620 / CP874).

const net = require('net');
const iconv = require('iconv-lite');

const PORT = parseInt(process.env.PRINTER_PORT, 10) || 9100;

function asPrintable(byte) {
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
}

const server = net.createServer((sock) => {
  console.log('[mock-printer] connect', sock.remoteAddress + ':' + sock.remotePort);
  const chunks = [];
  sock.on('data', (b) => chunks.push(b));
  sock.on('end', () => {
    const buf = Buffer.concat(chunks);
    console.log(`[mock-printer] disconnect (${buf.length} bytes)`);

    // Hex dump
    for (let i = 0; i < buf.length; i += 16) {
      const slice = buf.slice(i, i + 16);
      const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...slice].map(asPrintable).join('');
      console.log(`  ${i.toString(16).padStart(4, '0')}  ${hex.padEnd(48)}  ${ascii}`);
    }

    // Decoded as TIS-620 (Thai)
    try {
      const text = iconv.decode(buf, 'tis620');
      // strip ESC/POS control bytes for readability
      const stripped = text.replace(/[\x00-\x09\x0b-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(`  ── as TIS-620 text:\n  ${stripped}`);
    } catch (e) { /* ignore */ }
    console.log();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-printer] listening on 127.0.0.1:${PORT} — Ctrl+C to stop`);
});

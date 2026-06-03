// Opens a small popup window with a printable QR card and triggers
// the browser print dialog. Used by /admin (QR Code tab) and /staff
// (Customer QR modal) so staff can hand a paper QR to customers as
// an alternative to showing the screen.

import { apiBase } from './api';

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function openQrPrintWindow({
  url,
  tableName,
  tableCode,
  storeName,
  storeLogo,
  note,
  size = 480,
  copies = 1,
}) {
  if (typeof window === 'undefined') return;
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) {
    alert('Browser block popup — เปิด popup ของเว็บนี้ก่อน แล้วลองใหม่');
    return;
  }
  const qrSrc = `${apiBase}/api/qr?size=${size}&text=${encodeURIComponent(url)}`;
  const safeStore = escHtml(storeName || '');
  const safeLogo = escHtml(storeLogo || '');
  const safeName = escHtml(tableName || '');
  const safeCode = escHtml(tableCode || '');
  const safeUrl = escHtml(url || '');
  const safeNote = escHtml(note || 'สแกน QR เพื่อสั่งอาหาร');
  const copyCount = Math.max(1, Math.min(8, Number(copies) || 1));

  const oneCard = `
    <section class="qr-card">
      ${safeStore ? `<div class="store">${safeLogo ? safeLogo + ' ' : ''}${safeStore}</div>` : ''}
      <div class="note">${safeNote}</div>
      <div class="table-name">${safeName}</div>
      ${safeCode ? `<div class="table-code">${safeCode}</div>` : ''}
      <img class="qr" src="${qrSrc}" alt="QR ${safeCode}" />
      <div class="url">${safeUrl}</div>
      <div class="foot">โต๊ะ: ${safeName}${safeCode ? ' · ' + safeCode : ''}</div>
    </section>
  `;
  const cards = Array.from({ length: copyCount }, () => oneCard).join('');

  const html = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<title>พิมพ์ QR — ${safeName}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f4f4f6; font-family: system-ui, -apple-system, "Segoe UI", "Sarabun", sans-serif; color: #111; }
  body { padding: 24px 16px; }
  .toolbar {
    position: sticky; top: 0; background: #fff; padding: 10px 14px;
    border-radius: 10px; box-shadow: 0 4px 14px rgba(0,0,0,.08);
    display: flex; gap: 8px; justify-content: center; margin-bottom: 16px; flex-wrap: wrap;
  }
  .toolbar button {
    border: none; border-radius: 8px; padding: 9px 16px;
    font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .btn-primary { background: #1a1a2e; color: #fff; }
  .btn-secondary { background: #f0f0f5; color: #1a1a2e; }
  .sheet {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px;
    max-width: 760px;
    margin: 0 auto;
  }
  .qr-card {
    background: #fff;
    border: 2px dashed #999;
    border-radius: 14px;
    padding: 16px 14px;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .store { font-size: 13px; font-weight: 700; color: #555; margin-bottom: 4px; }
  .note { font-size: 12px; color: #777; margin-bottom: 6px; }
  .table-name { font-size: 26px; font-weight: 800; color: #1a1a2e; line-height: 1.1; }
  .table-code { font-size: 12px; color: #888; margin-top: 2px; }
  .qr { width: 100%; max-width: 220px; height: auto; display: block; margin: 12px auto; }
  .url { font-size: 10px; color: #666; word-break: break-all; padding: 0 4px; }
  .foot { font-size: 11px; color: #888; margin-top: 8px; }

  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none; }
    .sheet { max-width: none; margin: 0; gap: 0; }
    .qr-card { border-color: #ccc; box-shadow: none; margin: 6mm; padding: 8mm 6mm; }
    @page { size: auto; margin: 8mm; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-primary" onclick="window.print()">🖨 พิมพ์</button>
    <button class="btn-secondary" onclick="window.close()">ปิด</button>
  </div>
  <main class="sheet">${cards}</main>
  <script>
    // Wait for QR image(s) to load before auto-opening print dialog so
    // the customer never gets a half-rendered receipt.
    window.addEventListener('load', () => {
      const imgs = Array.from(document.images);
      let pending = imgs.length;
      if (!pending) { setTimeout(() => window.print(), 200); return; }
      imgs.forEach((img) => {
        if (img.complete) { if (!--pending) setTimeout(() => window.print(), 200); }
        else {
          img.addEventListener('load', () => { if (!--pending) setTimeout(() => window.print(), 200); });
          img.addEventListener('error', () => { if (!--pending) setTimeout(() => window.print(), 200); });
        }
      });
    });
  </script>
</body>
</html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
}

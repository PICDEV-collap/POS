/**
 * Text/barcode scale from label cell size (mm). Reference: 50×32 mm price tag.
 */
function barcodeLabelTextScale(cellWidthMm, cellHeightMm = 0) {
  const w = Math.max(12, Number(cellWidthMm) || 50);
  const h = Number(cellHeightMm) > 0
    ? Math.max(12, Number(cellHeightMm))
    : Math.max(20, w * 0.65);
  const refW = 50;
  const refH = 32;
  const raw = Math.min(w / refW, h / refH);
  return Math.min(1.35, Math.max(0.22, raw));
}

function isTinyBarcodeLabel(cellWidthMm, cellHeightMm = 0) {
  const w = Number(cellWidthMm) || 50;
  const h = Number(cellHeightMm) || 0;
  return w <= 25 || (h > 0 && h <= 14);
}

function barcodeRasterHeightPx(cellWidthMm, cellHeightMm = 0, requestedPx) {
  const scale = barcodeLabelTextScale(cellWidthMm, cellHeightMm);
  const hmm = Number(cellHeightMm) > 0 ? Number(cellHeightMm) : 0;
  if (hmm > 0) {
    const tiny = isTinyBarcodeLabel(cellWidthMm, hmm);
    const fromHeight = Math.round(hmm * 8 * (tiny ? 0.52 : 0.4));
    const maxH = Math.max(20, hmm * 8 - (tiny ? 14 : 24));
    return Math.max(20, Math.min(maxH, fromHeight));
  }
  const base = Math.max(40, Math.min(140, Number(requestedPx) || 80));
  return Math.max(20, Math.min(140, Math.round(base * scale)));
}

module.exports = {
  barcodeLabelTextScale,
  barcodeRasterHeightPx,
  isTinyBarcodeLabel,
};

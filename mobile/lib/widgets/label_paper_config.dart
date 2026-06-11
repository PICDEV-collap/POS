import 'package:flutter/material.dart';
import '../services/pos_printer_service.dart';

/// Shared label paper presets (same list as Bluetooth printer settings).
class LabelPaperPreset {
  final String label;
  final int widthMm;
  final int heightMm;
  final int gapMm;
  final String paperType;
  const LabelPaperPreset(
    this.label,
    this.widthMm,
    this.heightMm,
    this.gapMm,
    this.paperType,
  );
}

const kLabelPaperPresets = <LabelPaperPreset>[
  LabelPaperPreset('58mm ต่อเนื่อง', 58, 0, 0, 'continuous'),
  LabelPaperPreset('80mm ต่อเนื่อง', 80, 0, 0, 'continuous'),
  LabelPaperPreset('30×20', 30, 20, 2, 'gap'),
  LabelPaperPreset('40×30', 40, 30, 2, 'gap'),
  LabelPaperPreset('50×30', 50, 30, 2, 'gap'),
  LabelPaperPreset('60×30', 60, 30, 2, 'gap'),
  LabelPaperPreset('60×40', 60, 40, 2, 'gap'),
  LabelPaperPreset('75×60', 75, 60, 3, 'gap'),
];

/// Barcode height (px) scaled to label width — 58mm ≈ 80px reference.
int barcodeHeightForWidthMm(int widthMm, {int basePx = 80}) {
  final refMm = 58;
  return (basePx * (widthMm / refMm)).round().clamp(20, 140);
}

/// Barcode raster height from cell size (supports tiny 20×10 mm tags).
int barcodeHeightForLabelMm(int widthMm, int heightMm, {int basePx = 80}) {
  if (heightMm > 0) {
    final tiny = widthMm <= 25 || heightMm <= 14;
    final fromH = (heightMm * 8 * (tiny ? 0.52 : 0.4)).round();
    final maxH = (heightMm * 8 - (tiny ? 14 : 24)).clamp(20, 140);
    return fromH.clamp(20, maxH);
  }
  return barcodeHeightForWidthMm(widthMm, basePx: basePx);
}

class LabelPaperSelector extends StatelessWidget {
  final int widthMm;
  final int heightMm;
  final int gapMm;
  final String paperType;
  final ValueChanged<LabelPaperPreset> onPreset;
  final void Function(int widthMm, int heightMm, int gapMm, String paperType)?
  onCustom;

  const LabelPaperSelector({
    super.key,
    required this.widthMm,
    required this.heightMm,
    required this.gapMm,
    required this.paperType,
    required this.onPreset,
    this.onCustom,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'ขนาดกระดาษ / ฉลาก',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: kLabelPaperPresets.map((p) {
            final selected =
                widthMm == p.widthMm &&
                heightMm == p.heightMm &&
                paperType == p.paperType;
            return ChoiceChip(
              label: Text(p.label, style: const TextStyle(fontSize: 12)),
              selected: selected,
              onSelected: (_) => onPreset(p),
            );
          }).toList(),
        ),
        const SizedBox(height: 6),
        Text(
          'ตอนนี้: ${widthMm}mm × ${heightMm == 0 ? "auto" : "${heightMm}mm"}'
          ' · $paperType · barcode ~${barcodeHeightForWidthMm(widthMm)}px',
          style: const TextStyle(fontSize: 11, color: Colors.grey),
        ),
      ],
    );
  }
}

/// Load saved paper dimensions from printer prefs as defaults.
LabelPaperPreset defaultLabelPresetFromBt(PosPrinterService? pos) {
  if (pos == null) return kLabelPaperPresets.first;
  final match = kLabelPaperPresets.where(
    (p) =>
        p.widthMm == pos.labelWidthMm &&
        p.heightMm == pos.autoLabelHeightMm &&
        p.paperType == pos.paperType,
  );
  return match.isNotEmpty ? match.first : kLabelPaperPresets.first;
}

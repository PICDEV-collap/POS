import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'label_paper_config.dart';

/// Visual label template (Label Expert–style): sheet size + columns + layout.
class BarcodeLabelTemplate {
  final String id;
  final String name;
  final String category;

  /// Sheet / media width (mm).
  final int widthMm;
  final int heightMm;

  /// Sensor gap between rows on roll (mm).
  final int gapMm;
  final String paperType;
  final String layout;

  /// Labels across the sheet (1–6).
  final int columns;

  /// Space between columns (mm).
  final int columnGapMm;

  const BarcodeLabelTemplate({
    required this.id,
    required this.name,
    this.category = 'retail',
    required this.widthMm,
    required this.heightMm,
    this.gapMm = 2,
    this.paperType = 'gap',
    this.layout = 'price',
    this.columns = 1,
    this.columnGapMm = 0,
  });

  int get cellWidthMm {
    if (columns <= 1) return widthMm;
    final usable = widthMm - (columns - 1) * columnGapMm;
    return (usable / columns).floor().clamp(12, widthMm);
  }

  int get cellHeightMm => heightMm > 0 ? heightMm : 0;

  /// Human-readable per-label size (auto from sheet ÷ columns − gaps).
  String get cellSizeLabel {
    if (heightMm <= 0) return '${cellWidthMm} mm ต่อเนื่อง';
    if (columns <= 1) return '$cellWidthMm×$heightMm mm';
    return '$cellWidthMm×$heightMm mm/ดวง';
  }

  String get sheetSizeLabel {
    if (heightMm <= 0) return 'กระดาษ ${widthMm} mm';
    if (columns <= 1) return 'กระดาษ $widthMm×$heightMm mm';
    return 'กระดาษ $widthMm×$heightMm mm · $columns คอลัมน์ · gap $columnGapMm mm';
  }

  /// Text/bar scale vs reference 50×32 mm label.
  double get textScale {
    final w = cellWidthMm.toDouble().clamp(12, 200);
    final h = heightMm > 0 ? heightMm.toDouble().clamp(12, 300) : w * 0.65;
    final raw = (w / 50) < (h / 32) ? (w / 50) : (h / 32);
    return raw.clamp(0.22, 1.35);
  }

  String get sizeLabel {
    if (columns <= 1) {
      return heightMm > 0 ? '$widthMm×$heightMm mm' : '$widthMm mm ต่อเนื่อง';
    }
    return '$sheetSizeLabel\n$cellSizeLabel (คำนวณอัตโนมัติ)';
  }

  double get aspectRatio {
    if (heightMm <= 0) return widthMm >= 80 ? 0.45 : 0.35;
    return widthMm / heightMm;
  }

  /// Tiny die-cut tags (e.g. 20×10 mm) — barcode only, no name/price.
  bool get isTinyBarcodeLabel =>
      cellWidthMm <= 25 || (heightMm > 0 && heightMm <= 14);

  Map<String, dynamic> toJson() => {
    'id': id,
    'widthMm': widthMm,
    'heightMm': heightMm,
    'gapMm': gapMm,
    'paperType': paperType,
    'columns': columns,
    'columnGapMm': columnGapMm,
    'layout': layout,
  };
}

const kBarcodeLabelTemplates = <BarcodeLabelTemplate>[
  BarcodeLabelTemplate(
    id: 'tag-20x10',
    name: '20×10 (1 คอลัมน์)',
    category: 'retail',
    widthMm: 20,
    heightMm: 10,
    gapMm: 2,
    paperType: 'gap',
    columns: 1,
    columnGapMm: 0,
    layout: 'price',
  ),
  BarcodeLabelTemplate(
    id: 'roll-58',
    name: 'ม้วน 58mm',
    widthMm: 58,
    heightMm: 0,
    gapMm: 0,
    paperType: 'continuous',
    layout: 'roll',
  ),
  BarcodeLabelTemplate(
    id: 'roll-80',
    name: 'ม้วน 80mm',
    widthMm: 80,
    heightMm: 0,
    gapMm: 0,
    paperType: 'continuous',
    layout: 'roll',
  ),
  BarcodeLabelTemplate(
    id: 'price-50x25',
    name: 'ป้ายราคา',
    widthMm: 50,
    heightMm: 25,
  ),
  BarcodeLabelTemplate(
    id: 'price-50x30',
    name: 'ป้ายราคา',
    widthMm: 50,
    heightMm: 30,
  ),
  BarcodeLabelTemplate(
    id: 'price-60x30',
    name: 'ป้ายราคา',
    widthMm: 60,
    heightMm: 30,
  ),
  BarcodeLabelTemplate(
    id: 'price-60x34',
    name: 'ป้ายราคา',
    widthMm: 60,
    heightMm: 34,
  ),
  BarcodeLabelTemplate(
    id: 'price-60x40',
    name: 'ป้ายราคา',
    widthMm: 60,
    heightMm: 40,
  ),
  BarcodeLabelTemplate(
    id: 'promo-60x40',
    name: 'ราคาโปรโมชั่น',
    widthMm: 60,
    heightMm: 40,
    layout: 'promo',
  ),
  BarcodeLabelTemplate(
    id: 'sheet-75x129-4col',
    name: 'ฉลาก 4 คอลัมน์',
    widthMm: 75,
    heightMm: 129,
    columns: 4,
    columnGapMm: 1,
    gapMm: 2,
    paperType: 'gap',
  ),
];

const _kTemplateIdKey = 'pos_barcode_template_id';
const _kCustomLayoutKey = 'pos_barcode_custom_layout_v1';

const kDefaultCustomLayout = BarcodeLabelTemplate(
  id: 'custom',
  name: 'กำหนดเอง',
  widthMm: 75,
  heightMm: 129,
  columns: 4,
  columnGapMm: 1,
  gapMm: 2,
  paperType: 'gap',
);

Future<BarcodeLabelTemplate> loadSavedBarcodeTemplate({
  BarcodeLabelTemplate? fallback,
}) async {
  final p = await SharedPreferences.getInstance();
  final customRaw = p.getString(_kCustomLayoutKey);
  final id = p.getString(_kTemplateIdKey);
  if (id == 'custom' && customRaw != null) {
    try {
      final j = jsonDecode(customRaw) as Map<String, dynamic>;
      return BarcodeLabelTemplate(
        id: 'custom',
        name: 'กำหนดเอง',
        widthMm: (j['widthMm'] as num?)?.toInt() ?? 75,
        heightMm: (j['heightMm'] as num?)?.toInt() ?? 129,
        gapMm: (j['gapMm'] as num?)?.toInt() ?? 2,
        paperType: (j['paperType'] as String?) ?? 'gap',
        columns: (j['columns'] as num?)?.toInt().clamp(1, 6) ?? 4,
        columnGapMm: (j['columnGapMm'] as num?)?.toInt().clamp(0, 10) ?? 1,
        layout: (j['layout'] as String?) ?? 'price',
      );
    } catch (_) {}
  }
  if (id != null) {
    for (final t in kBarcodeLabelTemplates) {
      if (t.id == id) return t;
    }
  }
  return fallback ?? kBarcodeLabelTemplates[3];
}

Future<void> saveBarcodeTemplate(BarcodeLabelTemplate t) async {
  final p = await SharedPreferences.getInstance();
  await p.setString(_kTemplateIdKey, t.id);
  if (t.id == 'custom') {
    await p.setString(_kCustomLayoutKey, jsonEncode(t.toJson()));
  }
}

class BarcodeLabelPreview extends StatelessWidget {
  final BarcodeLabelTemplate template;
  final String? productName;
  final String? barcode;
  final double? price;
  final bool large;

  const BarcodeLabelPreview({
    super.key,
    required this.template,
    this.productName,
    this.barcode,
    this.price,
    this.large = false,
  });

  @override
  Widget build(BuildContext context) {
    final maxW = large ? 200.0 : 88.0;
    final ar = template.aspectRatio.clamp(0.15, 2.5);
    final h = (maxW / ar).clamp(large ? 100.0 : 40.0, large ? 280.0 : 110.0);
    return SizedBox(
      width: maxW,
      height: h,
      child: template.columns > 1
          ? _multiColumnPreview(maxW, h)
          : _singlePreview(maxW, h),
    );
  }

  Widget _multiColumnPreview(double maxW, double h) {
    final cols = template.columns;
    final gapMm = template.columnGapMm.toDouble();
    final scale = maxW / template.widthMm;
    final gapPx = gapMm * scale;
    final innerW = maxW - (large ? 12 : 8);
    final cellW = (innerW - (cols - 1) * gapPx) / cols;
    return Container(
      width: maxW,
      height: h,
      decoration: BoxDecoration(
        color: const Color(0xFFE8F0FF),
        border: Border.all(
          color: const Color(0xFFBBD4FF),
          width: large ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      padding: EdgeInsets.all(large ? 6 : 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: List.generate(cols * 2 - 1, (i) {
          if (i.isOdd) {
            return SizedBox(width: gapPx);
          }
          return SizedBox(
            width: cellW,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(3),
                border: Border.all(color: const Color(0xFFD0D8F0)),
              ),
              child: Padding(
                padding: EdgeInsets.all(large ? 3 : 2),
                child: _cellContent(large),
              ),
            ),
          );
        }),
      ),
    );
  }

  Widget _singlePreview(double maxW, double h) {
    return Container(
      width: maxW,
      height: h,
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(
          color: const Color(0xFFBBD4FF),
          width: large ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(4),
      ),
      padding: EdgeInsets.all(large ? 8 : 4),
      child: _cellContent(large),
    );
  }

  Widget _cellContent(bool large) {
    final name = productName ?? 'ชื่อสินค้า';
    final code = barcode ?? '1234567890';
    final priceText = price != null ? '฿${price!.toStringAsFixed(0)}' : '฿99';
    final s = template.textScale;
    final mul = large ? 1.08 : 1.0;
    double fs(double base) => (base * s * mul).clamp(4.0, large ? 22.0 : 13.0);

    Widget fitLine(
      String text, {
      required double baseSize,
      FontWeight weight = FontWeight.w600,
      Color? color,
    }) {
      final size = fs(baseSize);
      return Expanded(
        flex: baseSize >= 10 ? 2 : 1,
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.center,
          child: Text(
            text,
            maxLines: 2,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: size,
              fontWeight: weight,
              color: color,
              height: 1.05,
            ),
          ),
        ),
      );
    }

    final barH = fs(14).clamp(6.0, large ? 30.0 : 18.0);
    return LayoutBuilder(
      builder: (context, constraints) {
        if (template.isTinyBarcodeLabel && template.heightMm > 0) {
          return Center(
            child: FittedBox(
              fit: BoxFit.contain,
              child: _fakeBarcode(
                large,
                barHeight: barH.clamp(8.0, constraints.maxHeight * 0.85),
                maxWidth: constraints.maxWidth,
              ),
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            fitLine(name, baseSize: 11, weight: FontWeight.w700),
            Expanded(
              flex: 4,
              child: Center(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: _fakeBarcode(
                    large,
                    barHeight: barH,
                    maxWidth: constraints.maxWidth,
                  ),
                ),
              ),
            ),
            fitLine(priceText, baseSize: 11, weight: FontWeight.w900),
            fitLine(code, baseSize: 8, color: Colors.grey[800]),
          ],
        );
      },
    );
  }

  Widget _fakeBarcode(
    bool large, {
    required double barHeight,
    required double maxWidth,
  }) {
    final s = template.textScale;
    final barW = (large ? 2.0 : 1.2) * s.clamp(0.35, 1.2);
    final count = (maxWidth / (barW + 0.4)).floor().clamp(
      large ? 8 : 6,
      large ? 22 : 14,
    );
    return SizedBox(
      height: barHeight,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(
          count,
          (i) => Container(
            width: barW,
            height: barHeight,
            margin: const EdgeInsets.symmetric(horizontal: 0.2),
            color: i.isEven ? Colors.black : Colors.transparent,
          ),
        ),
      ),
    );
  }
}

class _MmField extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final int min;
  final int max;
  final ValueChanged<int> onChanged;

  const _MmField({
    required this.label,
    required this.controller,
    required this.min,
    required this.max,
    required this.onChanged,
  });

  int get _value => int.tryParse(controller.text) ?? min;

  void _bump(int delta) {
    final next = (_value + delta).clamp(min, max);
    controller.text = '$next';
    onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            label,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              IconButton(
                visualDensity: VisualDensity.compact,
                onPressed: _value > min ? () => _bump(-1) : null,
                icon: const Icon(Icons.remove_circle_outline),
              ),
              Expanded(
                child: TextField(
                  controller: controller,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 16,
                  ),
                  decoration: const InputDecoration(
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 10,
                    ),
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (raw) {
                    final v = int.tryParse(raw.trim()) ?? min;
                    final clamped = v.clamp(min, max);
                    controller.text = '$clamped';
                    onChanged(clamped);
                  },
                  onChanged: (raw) {
                    final v = int.tryParse(raw.trim());
                    if (v != null) onChanged(v.clamp(min, max));
                  },
                ),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                onPressed: _value < max ? () => _bump(1) : null,
                icon: const Icon(Icons.add_circle_outline),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class BarcodeLabelTemplatePicker extends StatefulWidget {
  final BarcodeLabelTemplate selected;
  final ValueChanged<BarcodeLabelTemplate> onChanged;
  final String? productName;
  final String? barcode;
  final double? price;

  const BarcodeLabelTemplatePicker({
    super.key,
    required this.selected,
    required this.onChanged,
    this.productName,
    this.barcode,
    this.price,
  });

  @override
  State<BarcodeLabelTemplatePicker> createState() =>
      BarcodeLabelTemplatePickerState();
}

class BarcodeLabelTemplatePickerState
    extends State<BarcodeLabelTemplatePicker> {
  /// Latest draft while editing; falls back to [widget.selected].
  BarcodeLabelTemplate templateForPrint() {
    if (_showGrid || _custom) return _customTemplate();
    return widget.selected;
  }

  bool _showGrid = false;
  bool _custom = false;
  late TextEditingController _wCtrl;
  late TextEditingController _hCtrl;
  late TextEditingController _colsCtrl;
  late TextEditingController _colGapCtrl;

  @override
  void initState() {
    super.initState();
    _wCtrl = TextEditingController();
    _hCtrl = TextEditingController();
    _colsCtrl = TextEditingController();
    _colGapCtrl = TextEditingController();
    _syncFrom(widget.selected);
  }

  @override
  void dispose() {
    _wCtrl.dispose();
    _hCtrl.dispose();
    _colsCtrl.dispose();
    _colGapCtrl.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant BarcodeLabelTemplatePicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    // While the settings panel is open, controllers are the source of truth.
    if (_showGrid) return;
    if (oldWidget.selected.id != widget.selected.id ||
        oldWidget.selected.widthMm != widget.selected.widthMm ||
        oldWidget.selected.heightMm != widget.selected.heightMm ||
        oldWidget.selected.columns != widget.selected.columns ||
        oldWidget.selected.columnGapMm != widget.selected.columnGapMm) {
      _syncFrom(widget.selected);
    }
  }

  void _syncFrom(BarcodeLabelTemplate t) {
    _wCtrl.text = '${t.widthMm}';
    _hCtrl.text = '${t.heightMm}';
    _colsCtrl.text = '${t.columns}';
    _colGapCtrl.text = '${t.columnGapMm}';
    _custom = t.id == 'custom';
  }

  BarcodeLabelTemplate _customTemplate() {
    final h = int.tryParse(_hCtrl.text.trim()) ?? 0;
    return BarcodeLabelTemplate(
      id: 'custom',
      name: 'กำหนดเอง',
      widthMm: (int.tryParse(_wCtrl.text.trim()) ?? 58).clamp(20, 120),
      heightMm: h.clamp(0, 200),
      columns: (int.tryParse(_colsCtrl.text.trim()) ?? 1).clamp(1, 6),
      columnGapMm: (int.tryParse(_colGapCtrl.text.trim()) ?? 0).clamp(0, 10),
      gapMm: h > 0 ? 2 : 0,
      paperType: h > 0 ? 'gap' : 'continuous',
      layout: 'price',
    );
  }

  BarcodeLabelTemplate get _previewTemplate =>
      (_showGrid || _custom) ? _customTemplate() : widget.selected;

  void _pickPreset(BarcodeLabelTemplate t) {
    unawaited(saveBarcodeTemplate(t));
    widget.onChanged(t);
    setState(() {
      _showGrid = false;
      _custom = false;
      _syncFrom(t);
    });
  }

  void _applyDefaultCustom() {
    setState(() {
      _custom = true;
      _wCtrl.text = '${kDefaultCustomLayout.widthMm}';
      _hCtrl.text = '${kDefaultCustomLayout.heightMm}';
      _colsCtrl.text = '${kDefaultCustomLayout.columns}';
      _colGapCtrl.text = '${kDefaultCustomLayout.columnGapMm}';
    });
  }

  void _commitCustom() {
    final draft = _customTemplate();
    unawaited(saveBarcodeTemplate(draft));
    widget.onChanged(draft);
    if (!mounted) return;
    setState(() {
      _custom = true;
      _showGrid = false;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('บันทึกขนาดฉลากแล้ว'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = _previewTemplate;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
          decoration: BoxDecoration(
            color: const Color(0xFFF4F7FF),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFBBD4FF)),
          ),
          child: Column(
            children: [
              BarcodeLabelPreview(
                template: t,
                productName: widget.productName,
                barcode: widget.barcode,
                price: widget.price,
                large: true,
              ),
              const SizedBox(height: 10),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  t.sizeLabel,
                  textAlign: TextAlign.center,
                  softWrap: true,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 15,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  t.columns > 1
                      ? '${t.sheetSizeLabel}\n${t.cellSizeLabel} · ${t.name}'
                      : '${t.cellSizeLabel} · ${t.name}',
                  textAlign: TextAlign.center,
                  softWrap: true,
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.grey[600],
                    height: 1.3,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () {
                    setState(() {
                      _showGrid = !_showGrid;
                      if (_showGrid) {
                        _syncFrom(widget.selected);
                      }
                    });
                  },
                  icon: Icon(_showGrid ? Icons.expand_less : Icons.tune),
                  label: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      _showGrid ? 'ซ่อนการตั้งค่า' : 'เปลี่ยนขนาด / แม่แบบ',
                    ),
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFF1A1A2E),
                    padding: const EdgeInsets.symmetric(
                      vertical: 10,
                      horizontal: 8,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        if (_showGrid) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: const Color(0xFFFAFAFC),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFE8E8EE)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'ฉลากกำหนดเอง',
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
                ),
                const SizedBox(height: 4),
                Text(
                  'ตั้งกระดาษ + คอลัมน์ — ระบบคำนวณขนาดฉลากต่อดวงและตัวอักษรใน preview ให้',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.grey[600],
                    height: 1.3,
                  ),
                ),
                const SizedBox(height: 10),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFFE8F0FF),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFBBD4FF)),
                  ),
                  child: Column(
                    children: [
                      Text(
                        'ขนาดฉลากต่อดวง (คำนวณอัตโนมัติ)',
                        style: TextStyle(fontSize: 11, color: Colors.grey[700]),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        t.cellSizeLabel,
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 18,
                        ),
                      ),
                      if (t.columns > 1) ...[
                        const SizedBox(height: 4),
                        Text(
                          t.sheetSizeLabel,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 10,
                            color: Colors.grey[600],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _MmField(
                  label: 'ความกว้างกระดาษ (mm)',
                  controller: _wCtrl,
                  min: 20,
                  max: 120,
                  onChanged: (_) => setState(() => _custom = true),
                ),
                _MmField(
                  label: 'ความสูงกระดาษ (mm)',
                  controller: _hCtrl,
                  min: 0,
                  max: 200,
                  onChanged: (_) => setState(() => _custom = true),
                ),
                _MmField(
                  label: 'คอลัมน์',
                  controller: _colsCtrl,
                  min: 1,
                  max: 6,
                  onChanged: (_) => setState(() => _custom = true),
                ),
                _MmField(
                  label: 'ระยะห่างคอลัมน์ (mm)',
                  controller: _colGapCtrl,
                  min: 0,
                  max: 10,
                  onChanged: (_) => setState(() => _custom = true),
                ),
                OutlinedButton(
                  onPressed: _applyDefaultCustom,
                  child: const Text('ค่าเริ่มต้น 75×129 · 4 คอลัมน์'),
                ),
                const SizedBox(height: 8),
                FilledButton(
                  onPressed: _commitCustom,
                  child: const Text('ใช้ค่านี้'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          const Text(
            'แม่แบบสำเร็จรูป',
            style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
          ),
          const SizedBox(height: 8),
          SizedBox(
            height: 260,
            child: GridView.builder(
              padding: const EdgeInsets.only(bottom: 4),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
                childAspectRatio: 0.72,
              ),
              itemCount: kBarcodeLabelTemplates.length,
              itemBuilder: (context, i) {
                final item = kBarcodeLabelTemplates[i];
                final sel = item.id == t.id && !_custom;
                return Material(
                  color: Colors.white,
                  elevation: sel ? 2 : 0,
                  shadowColor: Colors.black26,
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    onTap: () => _pickPreset(item),
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: sel
                              ? const Color(0xFF1A1A2E)
                              : const Color(0xFFE0E0E8),
                          width: sel ? 2.5 : 1,
                        ),
                      ),
                      child: Column(
                        children: [
                          Expanded(
                            child: Center(
                              child: BarcodeLabelPreview(
                                template: item,
                                productName: widget.productName,
                                barcode: widget.barcode,
                                price: widget.price,
                              ),
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            item.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          Text(
                            item.sizeLabel,
                            maxLines: 2,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 10,
                              color: Colors.grey[600],
                              height: 1.2,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ],
    );
  }
}

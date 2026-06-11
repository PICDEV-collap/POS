import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'api_service.dart';
import 'ble_print_debug.dart';
import 'pos_printer_service.dart';
import '../widgets/label_paper_config.dart';

/// Where a print job should be sent.
class PrintTarget {
  const PrintTarget._({
    required this.label,
    required this.bluetooth,
    this.stationKey,
  });

  final String label;
  final bool bluetooth;
  final String? stationKey;

  factory PrintTarget.bluetooth(String name) =>
      PrintTarget._(label: name, bluetooth: true);

  factory PrintTarget.server({String? stationKey, required String label}) =>
      PrintTarget._(label: label, bluetooth: false, stationKey: stationKey);
}

/// Ask the user which printer to use (built-in / Bluetooth vs server stations).
Future<PrintTarget?> pickPrintTarget(
  BuildContext context,
  ApiService api,
) async {
  final pos = context.read<PosPrinterService>();
  List<Map<String, dynamic>> stations = [];
  try {
    stations = await api.printStations();
  } catch (_) {}

  final choices = <PrintTarget>[];
  if (pos.hasPrinter) {
    choices.add(PrintTarget.bluetooth(pos.name ?? 'เครื่องพิมพ์'));
  }
  choices.add(PrintTarget.server(label: 'เครื่องพิมพ์หลัก (ค่าเริ่มต้น)'));
  for (final s in stations) {
    if (s['is_active'] == false) continue;
    final key = s['key'] as String?;
    if (key == null || key.isEmpty) continue;
    final name = (s['name'] as String?)?.trim();
    if (name == null || name.isEmpty) continue;
    final host = s['printer_key'] ?? s['printer_host'] ?? key;
    choices.add(PrintTarget.server(stationKey: key, label: '$name ($host)'));
  }

  if (choices.isEmpty) return null;
  if (choices.length == 1) return choices.first;

  return showDialog<PrintTarget>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('เลือกเครื่องพิมพ์'),
      content: SizedBox(
        width: double.maxFinite,
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final c in choices)
              ListTile(
                leading: Icon(
                  c.bluetooth ? Icons.print : Icons.dns,
                  color: c.bluetooth ? Colors.blue : null,
                ),
                title: Text(c.label, style: const TextStyle(fontSize: 14)),
                onTap: () => Navigator.pop(ctx, c),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('ยกเลิก'),
        ),
      ],
    ),
  );
}

Future<String> _printViaPos(
  PosPrinterService pos,
  ApiService api,
  Future<Map<String, dynamic>> Function() fetchPayload,
) async {
  try {
    final ready = await pos.warmUp();
    if (!ready) {
      return '❌ เชื่อมต่อเครื่องพิมพ์ไม่ได้: ${pos.lastError ?? "unknown"}';
    }
    final payload = await fetchPayload();
    final ok = await pos.printBase64(payload['bytes_base64'] as String);
    if (ok) {
      if (pos.usesBuiltIn) {
        return posPrintOkMessage(payload.cast<String, dynamic>(), printer: pos);
      }
      return blePrintOkMessage(
        payload.cast<String, dynamic>(),
        writeChar: pos.lastWriteCharUuid,
        notifyAck: pos.lastNotifySummary,
      );
    }
    return '❌ พิมพ์ไม่สำเร็จ: ${pos.lastError ?? "unknown"}';
  } catch (e) {
    return '❌ ${pos.usesBuiltIn ? "Sunmi" : "Bluetooth"}: $e';
  }
}

/// Unified entry point for printing from anywhere in the app.
Future<String> printOrder({
  required BuildContext context,
  required ApiService api,
  required int orderId,
  String type = 'kitchen', // 'kitchen' | 'receipt'
}) async {
  final pos = context.read<PosPrinterService>();
  if (pos.hasPrinter) {
    return _printViaPos(
      pos,
      api,
      () => api.getPrintPayload(
        orderId,
        type,
        widthPx: pos.widthPx,
        widthChars: pos.widthChars,
        renderMode: pos.autoRenderMode,
        protocol: pos.autoProtocol,
        labelWidthMm: pos.labelWidthMm,
        labelHeightMm: pos.autoLabelHeightMm,
        gapMm: pos.autoGapMm,
        blineMm: pos.autoBlineMm,
        paperType: pos.autoPaperType,
        bleProfile: pos.isAiyinBlePrinter && pos.protocol == 'escpos'
            ? 'aiyin'
            : null,
      ),
    );
  }
  return '⚠️ ยังไม่ได้จับคู่เครื่องพิมพ์ Bluetooth — เปิด ⚙️ ตั้งค่าเครื่องพิมพ์ แล้วเลือกเครื่องก่อนพิมพ์';
}

/// Print a product barcode label to paired Bluetooth / Sunmi printer.
Future<String> printProductBarcode({
  required BuildContext context,
  required ApiService api,
  required int productId,
  required int sheetWidthMm,
  required int cellWidthMm,
  required int labelHeightMm,
  required int gapMm,
  required String paperType,
  int labelColumns = 1,
  int columnGapMm = 0,
  int copies = 1,
}) async {
  final pos = context.read<PosPrinterService>();
  if (!pos.hasPrinter) {
    return '⚠️ ยังไม่ได้จับคู่เครื่องพิมพ์ — เปิด ⚙️ ตั้งค่าเครื่องพิมพ์';
  }
  if (!pos.usesBuiltIn) {
    await pos.bluetooth.setLabelSize(
      widthMm: cellWidthMm,
      heightMm: labelHeightMm,
      gapMm: gapMm,
      paperType: paperType,
    );
  }
  final widthPx = cellWidthMm * 8;
  final barH = barcodeHeightForLabelMm(cellWidthMm, labelHeightMm);
  final n = copies < 1 ? 1 : copies;
  final msg = await _printViaPos(
    pos,
    api,
    () => api.getBarcodePrintPayload(
      productId,
      widthPx: widthPx,
      widthChars: (cellWidthMm / 3).floor().clamp(8, 32),
      renderMode: pos.autoRenderMode,
      protocol: pos.autoProtocol,
      sheetWidthMm: sheetWidthMm,
      labelWidthMm: cellWidthMm,
      labelHeightMm: labelHeightMm > 0 ? labelHeightMm : null,
      gapMm: gapMm > 0 ? gapMm : null,
      paperType: paperType,
      labelColumns: labelColumns > 1 ? labelColumns : null,
      columnGapMm: columnGapMm > 0 ? columnGapMm : null,
      barcodeHeightPx: barH,
      copies: n,
      bleProfile: pos.isAiyinBlePrinter && pos.protocol == 'escpos'
          ? 'aiyin'
          : null,
    ),
  );
  if (n > 1 && msg.startsWith('✅')) {
    return '$msg · $n ดวง';
  }
  return msg;
}

/// Print a table QR label — user picks built-in/BT or a server printer.
Future<String> printQrLabel({
  required BuildContext context,
  required ApiService api,
  required String url,
  String? tableName,
  String? tableCode,
  String? storeName,
  String? storeLogo,
  String? note,
  String? footer,
  int copies = 1,
}) async {
  final target = await pickPrintTarget(context, api);
  if (target == null) return 'ยกเลิกการพิมพ์';

  if (target.bluetooth) {
    final pos = context.read<PosPrinterService>();
    final msg = await _printViaPos(
      pos,
      api,
      () => api.getQrPrintPayload(
        url: url,
        tableName: tableName,
        tableCode: tableCode,
        storeName: storeName,
        storeLogo: storeLogo,
        note: note,
        footer: footer,
        widthPx: pos.widthPx,
        widthChars: pos.widthChars,
        renderMode: pos.autoRenderMode,
        protocol: pos.autoProtocol,
        labelWidthMm: pos.labelWidthMm,
        labelHeightMm: pos.autoLabelHeightMm,
        gapMm: pos.autoGapMm,
        blineMm: pos.autoBlineMm,
        paperType: pos.autoPaperType,
        bleProfile: pos.isAiyinBlePrinter && pos.protocol == 'escpos'
            ? 'aiyin'
            : null,
      ),
    );
    if (msg.startsWith('✅')) {
      final where = pos.name ?? 'เครื่องพิมพ์';
      return msg
          .replaceFirst('ส่งแล้ว', 'พิมพ์ QR → $where')
          .replaceFirst('พิมพ์แล้ว', 'พิมพ์ QR → $where');
    }
    return msg;
  }

  try {
    final r = await api.printQrLabel(
      url: url,
      tableName: tableName,
      tableCode: tableCode,
      storeName: storeName,
      storeLogo: storeLogo,
      note: note,
      footer: footer,
      copies: copies,
      stationKey: target.stationKey,
    );
    if (r['queued'] == true) {
      final where = target.stationKey == null ? 'server' : target.label;
      return '✅ ส่งคิวพิมพ์ QR → $where';
    }
    return '✅ ส่งคิวพิมพ์ QR แล้ว';
  } catch (e) {
    return '❌ พิมพ์ผ่าน server ไม่สำเร็จ: $e';
  }
}

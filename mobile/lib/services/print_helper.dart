import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'api_service.dart';
import 'bluetooth_printer_service.dart';

/// Unified entry point for printing from anywhere in the app.
///
/// Logic:
///   1. If a Bluetooth printer is selected — fetch payload from server and
///      stream bytes to BT.
///   2. Otherwise — fall back to server-side TCP printer via /api/print/order.
///
/// Returns a SnackBar-friendly message describing what happened.
Future<String> printOrder({
  required BuildContext context,
  required ApiService api,
  required int orderId,
  String type = 'kitchen', // 'kitchen' | 'receipt'
}) async {
  final bt = context.read<BluetoothPrinterService>();
  if (bt.hasPrinter) {
    try {
      final payload = await api.getPrintPayload(
        orderId,
        type,
        widthPx: bt.widthPx,
        widthChars: bt.widthChars,
        renderMode: bt.renderMode,
        protocol: bt.protocol,
        labelWidthMm: bt.labelWidthMm,
        labelHeightMm: bt.labelHeightMm,
        gapMm: bt.gapMm,
        blineMm: bt.blineMm,
        paperType: bt.paperType,
      );
      final ok = await bt.printBase64(payload['bytes_base64'] as String);
      if (ok) return '✅ พิมพ์ผ่าน Bluetooth (${payload['bytes_length']} bytes)';
      return '❌ Bluetooth พิมพ์ไม่สำเร็จ: ${bt.lastError ?? "unknown"}';
    } catch (e) {
      return '❌ Bluetooth: $e';
    }
  }
  // Fallback to server-side printer (queues a job)
  try {
    final r = await api.printOrder(orderId, type);
    if (r['skipped'] == true) {
      return '⚠️ Server printer ข้าม: ${r['reason']}';
    }
    return '✅ ส่งคิวพิมพ์ที่ server (job#${r['id']})';
  } catch (e) {
    return '❌ พิมพ์ผ่าน server ไม่สำเร็จ: $e';
  }
}

import 'package:flutter/foundation.dart';

import 'bluetooth_printer_service.dart';
import 'sunmi_printer_service.dart';

/// Routes print jobs to Sunmi built-in printer or paired BLE printer.
class PosPrinterService extends ChangeNotifier {
  PosPrinterService({required this.bluetooth});

  final BluetoothPrinterService bluetooth;
  final SunmiPrinterService _sunmi = SunmiPrinterService();

  bool get usesBuiltIn => _sunmi.ready;
  bool get isSunmiDevice => _sunmi.isSunmiDevice;
  bool get hasPrinter => usesBuiltIn || bluetooth.hasPrinter;

  String? get name => usesBuiltIn ? _sunmi.displayName : bluetooth.name;
  String? get lastError => usesBuiltIn ? _sunmi.lastError : bluetooth.lastError;

  String? get lastWriteCharUuid =>
      usesBuiltIn ? 'sunmi' : bluetooth.lastWriteCharUuid;
  String get lastNotifySummary =>
      usesBuiltIn ? 'builtin' : bluetooth.lastNotifySummary;

  bool get isAiyinBlePrinter => !usesBuiltIn && bluetooth.isAiyinBlePrinter;

  int get widthPx => usesBuiltIn ? _sunmi.widthPx : bluetooth.widthPx;
  int get widthChars => usesBuiltIn ? _sunmi.widthChars : bluetooth.widthChars;
  String get protocol => usesBuiltIn ? _sunmi.protocol : bluetooth.protocol;
  String get autoProtocol =>
      usesBuiltIn ? _sunmi.protocol : bluetooth.autoProtocol;
  String get autoRenderMode =>
      usesBuiltIn ? _sunmi.renderMode : bluetooth.autoRenderMode;
  String get autoPaperType =>
      usesBuiltIn ? _sunmi.paperType : bluetooth.autoPaperType;
  int get labelWidthMm =>
      usesBuiltIn ? _sunmi.labelWidthMm : bluetooth.labelWidthMm;
  int get autoLabelHeightMm => usesBuiltIn ? 0 : bluetooth.autoLabelHeightMm;
  int get autoGapMm => usesBuiltIn ? 0 : bluetooth.autoGapMm;
  int get autoBlineMm => usesBuiltIn ? 0 : bluetooth.autoBlineMm;
  String get paperType => usesBuiltIn ? _sunmi.paperType : bluetooth.paperType;

  bool get autoPrintKitchen => bluetooth.autoPrintKitchen;
  bool get autoPrintReceipt => bluetooth.autoPrintReceipt;

  Future<void> bootstrap() async {
    await _sunmi.bootstrap();
    await bluetooth.bootstrap();
    bluetooth.addListener(_onBluetoothChanged);
    notifyListeners();
  }

  void _onBluetoothChanged() => notifyListeners();

  Future<bool> warmUp() {
    if (usesBuiltIn) return _sunmi.warmUp();
    return bluetooth.warmUp();
  }

  Future<bool> printBase64(String b64, {bool acceptPartialWrite = false}) {
    if (usesBuiltIn) return _sunmi.printBase64(b64);
    return bluetooth.printBase64(b64, acceptPartialWrite: acceptPartialWrite);
  }

  Future<bool> printBytes(List<int> bytes, {bool acceptPartialWrite = false}) {
    if (usesBuiltIn) return _sunmi.printBytes(bytes);
    return bluetooth.printBytes(bytes, acceptPartialWrite: acceptPartialWrite);
  }

  Future<bool> setupContinuousPaper() {
    if (usesBuiltIn) return Future.value(true);
    return bluetooth.setupContinuousPaper();
  }

  Future<void> setAutoPrint({bool? kitchen, bool? receipt}) =>
      bluetooth.setAutoPrint(kitchen: kitchen, receipt: receipt);

  @override
  void dispose() {
    bluetooth.removeListener(_onBluetoothChanged);
    super.dispose();
  }
}

String posPrintOkMessage(
  Map<String, dynamic> payload, {
  required PosPrinterService printer,
}) {
  if (printer.usesBuiltIn) {
    final bytes = payload['bytes_length'];
    final proto = payload['protocol'] ?? 'escpos';
    return '✅ พิมพ์แล้ว · ${bytes ?? '?'} B · $proto · Sunmi ในตัว';
  }
  return '✅ ส่งแล้ว · ${payload['bytes_length'] ?? '?'} B · '
      '${payload['protocol'] ?? payload['ble_profile'] ?? 'escpos'} · '
      'ch:${printer.lastWriteCharUuid} · ack:${printer.lastNotifySummary}';
}

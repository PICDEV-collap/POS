import 'dart:convert';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:sunmi_printer_plus/sunmi_printer_plus.dart';

/// Built-in thermal printer on Sunmi POS terminals (V2, V2 Pro, etc.).
class SunmiPrinterService {
  bool _ready = false;
  bool _isSunmiDevice = false;
  String? _model;
  String? _lastError;

  bool get ready => _ready;
  bool get isSunmiDevice => _isSunmiDevice;
  String? get model => _model;
  String? get lastError => _lastError;

  String get displayName {
    final m = (_model ?? '').trim();
    if (m.isEmpty) return 'Sunmi (ในตัว)';
    return 'Sunmi $m (ในตัว)';
  }

  /// Sunmi V2 — 58mm receipt, ESC/POS bitmap from backend.
  int get widthPx => 384;
  int get widthChars => 32;
  String get protocol => 'escpos';
  String get renderMode => 'image';
  String get paperType => 'continuous';
  int get labelWidthMm => 58;

  Future<bool> bootstrap() async {
    _ready = false;
    _isSunmiDevice = false;
    _model = null;
    _lastError = null;

    if (kIsWeb || !Platform.isAndroid) return false;

    try {
      final info = await DeviceInfoPlugin().androidInfo;
      final mfr = info.manufacturer.toLowerCase();
      final model = info.model.toLowerCase();
      final brand = info.brand.toLowerCase();
      _isSunmiDevice =
          mfr.contains('sunmi') ||
          brand.contains('sunmi') ||
          model.contains('sunmi');
      _model = info.model;
      if (!_isSunmiDevice) return false;

      final bound = await SunmiPrinterPlus().rebindPrinter();
      _ready = bound;
      if (!bound) {
        _lastError = 'bind Sunmi printer service failed';
      }
      return _ready;
    } catch (e) {
      _lastError = e.toString();
      _ready = false;
      return false;
    }
  }

  Future<bool> printBytes(List<int> bytes) async {
    if (!_ready) {
      _lastError = 'Sunmi printer not ready';
      return false;
    }
    try {
      await SunmiPrinter.printEscPos(bytes);
      _lastError = null;
      return true;
    } catch (e) {
      _lastError = e.toString();
      return false;
    }
  }

  Future<bool> printBase64(String b64) => printBytes(base64.decode(b64));

  Future<bool> warmUp() async => _ready;
}

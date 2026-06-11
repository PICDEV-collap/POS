// Runtime configuration. Resolution order:
//   1. SharedPreferences override (set via /settings screen)
//   2. --dart-define=POS_API_BASE=http://...
//   3. http://localhost:4000

import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:shared_preferences/shared_preferences.dart';

class AppConfig {
  static const String _kOverride = 'pos_api_base_override';

  static const String compileTimeBase = String.fromEnvironment(
    'POS_API_BASE',
    defaultValue: 'http://localhost:4000',
  );

  static String _runtimeBase = compileTimeBase;
  static String get apiBase => _runtimeBase;
  static bool get isMobileLocalhostBase {
    if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return false;
    final host = Uri.tryParse(_runtimeBase)?.host.toLowerCase();
    return host == 'localhost' || host == '127.0.0.1' || host == '::1';
  }

  static Future<void> bootstrap() async {
    final p = await SharedPreferences.getInstance();
    final override = p.getString(_kOverride);
    if (override != null && override.isNotEmpty) {
      _runtimeBase = _normalize(override);
      if (isMobileLocalhostBase) {
        await p.remove(_kOverride);
        _runtimeBase = _normalize(compileTimeBase);
      }
    } else {
      _runtimeBase = _normalize(compileTimeBase);
    }
  }

  static Future<void> setApiBase(String url) async {
    final p = await SharedPreferences.getInstance();
    final normalized = _normalize(url);
    if (normalized.isEmpty) {
      await p.remove(_kOverride);
      _runtimeBase = _normalize(compileTimeBase);
    } else {
      await p.setString(_kOverride, normalized);
      _runtimeBase = normalized;
    }
  }

  static String _normalize(String url) {
    return url.trim().replaceAll(RegExp(r'/+$'), '');
  }
}

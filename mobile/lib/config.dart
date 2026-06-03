// Runtime configuration. Resolution order:
//   1. SharedPreferences override (set via /settings screen)
//   2. --dart-define=POS_API_BASE=http://...
//   3. http://localhost:4000

import 'dart:io' show HttpClient, HttpOverrides, Platform, SecurityContext;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AppConfig {
  static const String buildLabel = '20260529-credential-login';
  static const String _kOverride = 'pos_api_base_override';
  static const String _kCompileBaseSeen = 'pos_api_base_compile_seen';

  static const String compileTimeBase = String.fromEnvironment(
    'POS_API_BASE',
    defaultValue: 'http://localhost:4000',
  );

  static String _runtimeBase = compileTimeBase;
  static String get apiBase => _runtimeBase;
  static bool get isPublicRemoteBase => _isPublicBase(_runtimeBase);
  static bool get isNgrokFreeBase {
    return _isNgrokBase(_runtimeBase);
  }

  static void installNetworkOverrides() {
    if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return;
    HttpOverrides.global = _PosHttpOverrides();
  }

  static Map<String, String> tunnelHeadersFor(String baseUrl) {
    final host = Uri.tryParse(_normalize(baseUrl))?.host.toLowerCase() ?? '';
    if (!(host.endsWith('.ngrok-free.app') ||
        host.endsWith('.ngrok-free.dev'))) {
      return const {};
    }
    return const {'ngrok-skip-browser-warning': 'true'};
  }

  static Map<String, String> get tunnelHeaders {
    if (!isNgrokFreeBase) return const {};
    return const {'ngrok-skip-browser-warning': 'true'};
  }

  static http.Client httpClientFor([String? baseUrl]) {
    if (kIsWeb) return http.Client();
    final uri = Uri.tryParse(_normalize(baseUrl ?? _runtimeBase));
    final host = uri?.host.toLowerCase() ?? '';
    final isNgrok =
        host.endsWith('.ngrok-free.app') || host.endsWith('.ngrok-free.dev');
    if (!isNgrok) return http.Client();

    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8)
      ..idleTimeout = const Duration(seconds: 8)
      ..badCertificateCallback = (cert, certHost, port) {
        // Android on some shop devices fails the ngrok certificate chain even
        // when browsers accept it. Limit the bypass to the active ngrok base.
        return host.endsWith('.ngrok-free.app') ||
            host.endsWith('.ngrok-free.dev') ||
            certHost.toLowerCase() == host;
      };
    return IOClient(client);
  }

  static bool get isMobileLocalhostBase {
    if (kIsWeb || !(Platform.isAndroid || Platform.isIOS)) return false;
    final host = Uri.tryParse(_runtimeBase)?.host.toLowerCase();
    return host == 'localhost' || host == '127.0.0.1' || host == '::1';
  }

  static Future<void> bootstrap() async {
    final p = await SharedPreferences.getInstance();
    final override = p.getString(_kOverride);
    final normalizedCompile = _normalize(compileTimeBase);
    final previousCompile = p.getString(_kCompileBaseSeen);
    if (override != null && override.isNotEmpty) {
      _runtimeBase = _normalize(override);
      final compileIsNgrok = _isNgrokBase(normalizedCompile);
      final runtimeIsNgrok = _isNgrokBase(_runtimeBase);
      final shouldMoveToCompileBase =
          (previousCompile == null || previousCompile != normalizedCompile) &&
          _isPublicBase(normalizedCompile) &&
          (_isPrivateBase(_runtimeBase) ||
              _sameHost(_runtimeBase, normalizedCompile) ||
              (compileIsNgrok && runtimeIsNgrok));
      if (isMobileLocalhostBase || shouldMoveToCompileBase) {
        await p.remove(_kOverride);
        _runtimeBase = normalizedCompile;
      }
    } else {
      _runtimeBase = normalizedCompile;
    }
    await p.setString(_kCompileBaseSeen, normalizedCompile);
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

  static String normalizeBase(String url) => _normalize(url);

  static Future<bool> repairBaseAfterHandshake() async {
    final httpsTunnelBase = _httpsTunnelBase(_runtimeBase);
    if (httpsTunnelBase != null && httpsTunnelBase != _runtimeBase) {
      await setApiBase(httpsTunnelBase);
      return true;
    }
    final repaired = handshakeFallbackBase(_runtimeBase);
    if (repaired == null || repaired == _runtimeBase) return false;
    final currentHost = Uri.tryParse(_runtimeBase)?.host.toLowerCase() ?? '';
    if (_isPrivateHost(currentHost) ||
        currentHost == 'localhost' ||
        currentHost == '127.0.0.1' ||
        currentHost == '::1') {
      await setApiBase(repaired);
    } else {
      // Keep public HTTPS persisted. The HTTP fallback is runtime-only for
      // Android/ngrok TLS edge cases and should not become saved config.
      _runtimeBase = repaired;
    }
    return true;
  }

  static String? handshakeFallbackBase(String url) {
    final uri = Uri.tryParse(_normalize(url));
    if (uri == null || uri.scheme.toLowerCase() != 'https') return null;
    final host = uri.host.toLowerCase();
    final isPrivate =
        host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        _isPrivateHost(host);
    if (!isPrivate) return null;
    return uri.replace(scheme: 'http').toString();
  }

  static bool isHandshakeError(Object e) {
    final raw = e.toString();
    return raw.contains('HandshakeException') ||
        raw.contains('handshake') ||
        raw.contains('CERTIFICATE_VERIFY_FAILED') ||
        raw.contains('TLS');
  }

  static String friendlyNetworkError(Object e, {String? url}) {
    final raw = e.toString();
    final target = Uri.tryParse(_normalize(url ?? _runtimeBase));
    final host = target?.host.toLowerCase() ?? '';
    final isLocal =
        host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        _isPrivateHost(host);
    if (isHandshakeError(e)) {
      if (isLocal) {
        return 'เชื่อมต่อ HTTPS กับ server ภายในร้านไม่ได้ ให้ใช้ http://$host:4000';
      }
      if (host.endsWith('.ngrok-free.app') ||
          host.endsWith('.ngrok-free.dev')) {
        return 'เชื่อมต่อ HTTPS กับ ngrok ไม่สำเร็จ ตรวจว่า ngrok ยังรันอยู่ หรือใช้โดเมนจริงที่มี SSL';
      }
      return 'เชื่อมต่อ HTTPS ไม่สำเร็จ กรุณาตรวจ public URL หรือใช้โดเมนจริงที่มี SSL';
    }
    if (raw.contains('Connection refused') || raw.contains('SocketException')) {
      return 'เชื่อมต่อ server ไม่ได้ ตรวจว่า server/ngrok เปิดอยู่และ URL ถูกต้อง';
    }
    return raw.replaceFirst('Exception: ', '');
  }

  static bool _isPublicBase(String url) {
    final host = Uri.tryParse(_normalize(url))?.host.toLowerCase() ?? '';
    if (host.isEmpty) return false;
    if (host == 'localhost' || host == '127.0.0.1' || host == '::1') {
      return false;
    }
    return !_isPrivateHost(host);
  }

  static bool _isPrivateBase(String url) {
    final host = Uri.tryParse(_normalize(url))?.host.toLowerCase() ?? '';
    return host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        _isPrivateHost(host);
  }

  static bool _isNgrokBase(String url) {
    final host = Uri.tryParse(_normalize(url))?.host.toLowerCase() ?? '';
    return host.endsWith('.ngrok-free.app') || host.endsWith('.ngrok-free.dev');
  }

  static String? _httpsTunnelBase(String url) {
    final uri = Uri.tryParse(url.trim().replaceAll(RegExp(r'/+$'), ''));
    if (uri == null) return null;
    final host = uri.host.toLowerCase();
    final isNgrok =
        host.endsWith('.ngrok-free.app') || host.endsWith('.ngrok-free.dev');
    if (!isNgrok || uri.scheme.toLowerCase() == 'https') return null;
    return uri.replace(scheme: 'https').toString();
  }

  static bool _isPrivateHost(String host) {
    return host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(host);
  }

  static bool _sameHost(String a, String b) {
    final left = Uri.tryParse(_normalize(a))?.host.toLowerCase() ?? '';
    final right = Uri.tryParse(_normalize(b))?.host.toLowerCase() ?? '';
    return left.isNotEmpty && left == right;
  }

  static String _normalize(String url) {
    var value = url.trim().replaceAll(RegExp(r'/+$'), '');
    if (value.isEmpty) return '';
    if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(value)) {
      final host = value.split('/').first.toLowerCase();
      final isLan =
          _isPrivateHost(host) ||
          host.startsWith('localhost') ||
          host.startsWith('127.');
      value = '${isLan ? 'http' : 'https'}://$value';
    } else {
      final uri = Uri.tryParse(value);
      final host = uri?.host.toLowerCase() ?? '';
      final isNgrok =
          host.endsWith('.ngrok-free.app') || host.endsWith('.ngrok-free.dev');
      if (isNgrok && uri != null && uri.scheme.toLowerCase() != 'https') {
        value = uri.replace(scheme: 'https').toString();
      }
      final isPlainLocalServer =
          uri?.scheme.toLowerCase() == 'https' &&
          (uri?.port == 4000 || uri?.port == 3000 || uri?.hasPort == false) &&
          (host == 'localhost' ||
              host == '127.0.0.1' ||
              host == '::1' ||
              _isPrivateHost(host));
      if (isPlainLocalServer && uri != null) {
        value = uri.replace(scheme: 'http').toString();
      }
    }
    return value;
  }
}

class _PosHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.badCertificateCallback = (cert, host, port) {
      final normalized = host.toLowerCase();
      return normalized.endsWith('.ngrok-free.app') ||
          normalized.endsWith('.ngrok-free.dev');
    };
    return client;
  }
}

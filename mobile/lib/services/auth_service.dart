import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import '../models/product.dart';

class AuthUser {
  final int id;
  final String username;
  final String? fullName;
  final String role;
  final int storeId;
  final List<int> allowedStoreIds;
  final List<String> permissions;

  AuthUser({
    required this.id,
    required this.username,
    this.fullName,
    required this.role,
    required this.storeId,
    required this.allowedStoreIds,
    required this.permissions,
  });

  factory AuthUser.fromJson(Map<String, dynamic> j) => AuthUser(
    id: j['id'] as int,
    username: j['username'] as String,
    fullName: j['full_name'] as String?,
    role: j['role'] as String,
    storeId: int.tryParse((j['store_id'] ?? 1).toString()) ?? 1,
    allowedStoreIds:
        (j['allowed_store_ids'] as List?)
            ?.map((e) => int.tryParse(e.toString()))
            .whereType<int>()
            .where((id) => id > 0)
            .toList() ??
        const [1],
    permissions:
        (j['permissions'] as List?)?.map((e) => e.toString()).toList() ??
        const [],
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'username': username,
    'full_name': fullName,
    'role': role,
    'store_id': storeId,
    'allowed_store_ids': allowedStoreIds,
    'permissions': permissions,
  };

  bool get isSuperAdmin => role == 'super_admin';
  bool get isMobileStoreAdmin =>
      role == 'admin' &&
      (permissions.contains('mobile_admin') ||
          permissions.contains('store_admin'));
}

class AuthService extends ChangeNotifier {
  static const _kToken = 'pos_token';
  static const _kRefresh = 'pos_refresh_token';
  static const _kUser = 'pos_user';
  static const _kActiveStore = 'pos_active_store_id';

  String? _token;
  String? _refreshToken;
  AuthUser? _user;
  int? _activeStoreId;

  String? get token => _token;
  AuthUser? get user => _user;
  int? get activeStoreId => _activeStoreId ?? _user?.storeId;
  bool get isLoggedIn => _token != null && _user != null;

  Future<void> bootstrap({bool restoreSession = true}) async {
    final p = await SharedPreferences.getInstance();
    if (!restoreSession) {
      _token = null;
      _user = null;
      _activeStoreId = null;
      await p.remove(_kToken);
      await p.remove(_kRefresh);
      await p.remove(_kUser);
      await p.remove(_kActiveStore);
      notifyListeners();
      return;
    }
    _token = p.getString(_kToken);
    _refreshToken = p.getString(_kRefresh);
    _activeStoreId = p.getInt(_kActiveStore);
    final raw = p.getString(_kUser);
    if (raw != null) {
      try {
        _user = AuthUser.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      } catch (_) {
        _user = null;
        _token = null;
      }
    }
    _activeStoreId = _validActiveStore(_activeStoreId);
    notifyListeners();
  }

  int? _validActiveStore(int? value) {
    final user = _user;
    if (user == null) return null;
    final requested = value ?? user.storeId;
    if (user.role == 'super_admin') return requested;
    final allowed = user.allowedStoreIds.isEmpty
        ? <int>[user.storeId]
        : user.allowedStoreIds;
    return allowed.contains(requested) ? requested : user.storeId;
  }

  Future<void> setActiveStoreId(int storeId) async {
    _activeStoreId = _validActiveStore(storeId);
    final p = await SharedPreferences.getInstance();
    if (_activeStoreId == null) {
      await p.remove(_kActiveStore);
    } else {
      await p.setInt(_kActiveStore, _activeStoreId!);
    }
    notifyListeners();
  }

  Future<List<PosStore>> loginStores() async {
    final body = await _getAuth('/api/auth/stores');
    final list = body as List;
    return list
        .map((j) => PosStore.fromJson(j as Map<String, dynamic>))
        .where((store) => store.isActive)
        .toList();
  }

  Future<void> login(String username, String password, {int? storeId}) async {
    final body = await _postAuth(
      '/api/auth/login',
      body: {
        'username': username,
        'password': password,
        if (storeId != null) 'store_id': storeId,
      },
    );
    await _applyAuthResponse(body);
  }

  Future<dynamic> _getAuth(String path) async {
    try {
      return await _getAuthOnce(path);
    } catch (e) {
      if (AppConfig.isHandshakeError(e) &&
          await AppConfig.repairBaseAfterHandshake()) {
        return _getAuthOnce(path);
      }
      throw Exception(AppConfig.friendlyNetworkError(e));
    }
  }

  Future<dynamic> _getAuthOnce(String path) async {
    final client = AppConfig.httpClientFor();
    try {
      final res = await client
          .get(
            Uri.parse('${AppConfig.apiBase}$path'),
            headers: AppConfig.tunnelHeaders,
          )
          .timeout(const Duration(seconds: 5));
      if (res.statusCode != 200) {
        String msg = 'load stores failed';
        try {
          msg = (jsonDecode(res.body) as Map)['error']?.toString() ?? msg;
        } catch (_) {}
        throw Exception(msg);
      }
      return jsonDecode(utf8.decode(res.bodyBytes));
    } finally {
      client.close();
    }
  }

  Future<Map<String, dynamic>> _postAuth(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    try {
      return await _postAuthOnce(path, body: body);
    } catch (e) {
      if (AppConfig.isHandshakeError(e) &&
          await AppConfig.repairBaseAfterHandshake()) {
        return _postAuthOnce(path, body: body);
      }
      throw Exception(AppConfig.friendlyNetworkError(e));
    }
  }

  Future<Map<String, dynamic>> _postAuthOnce(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = AppConfig.httpClientFor();
    try {
      final res = await client
          .post(
            Uri.parse('${AppConfig.apiBase}$path'),
            headers: {
              ...AppConfig.tunnelHeaders,
              if (body != null) 'Content-Type': 'application/json',
            },
            body: body == null ? null : jsonEncode(body),
          )
          .timeout(const Duration(seconds: 5));
      if (res.statusCode != 200) {
        String msg = path.contains('login')
            ? 'login failed'
            : 'staff session failed';
        try {
          msg = (jsonDecode(res.body) as Map)['error']?.toString() ?? msg;
        } catch (_) {}
        throw Exception(msg);
      }
      return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } finally {
      client.close();
    }
  }

  Future<void> _applyAuthResponse(Map<String, dynamic> body) async {
    _token = body['token'] as String;
    _refreshToken = body['refresh_token'] as String?;
    _user = AuthUser.fromJson(body['user'] as Map<String, dynamic>);
    _activeStoreId = _validActiveStore(_user!.storeId);
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, _token!);
    if (_refreshToken != null) {
      await p.setString(_kRefresh, _refreshToken!);
    } else {
      await p.remove(_kRefresh);
    }
    await p.setString(_kUser, jsonEncode(_user!.toJson()));
    await p.setInt(_kActiveStore, _activeStoreId!);
    notifyListeners();
  }

  Future<bool> refreshSession() async {
    if (_refreshToken == null || _refreshToken!.isEmpty) return false;
    try {
      final body = await _postAuth(
        '/api/auth/refresh',
        body: {
          'refresh_token': _refreshToken,
          if (_activeStoreId != null) 'store_id': _activeStoreId,
        },
      );
      await _applyAuthResponse(body);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> logout() async {
    final refresh = _refreshToken;
    _token = null;
    _refreshToken = null;
    _user = null;
    _activeStoreId = null;
    final p = await SharedPreferences.getInstance();
    await p.remove(_kToken);
    await p.remove(_kRefresh);
    await p.remove(_kUser);
    await p.remove(_kActiveStore);
    notifyListeners();
    if (refresh == null || refresh.isEmpty) return;
    try {
      await _postAuth('/api/auth/logout', body: {'refresh_token': refresh});
    } catch (_) {}
  }
}

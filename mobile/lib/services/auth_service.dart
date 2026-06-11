import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';

class AuthUser {
  final int id;
  final String username;
  final String? fullName;
  final String role;

  AuthUser({
    required this.id,
    required this.username,
    this.fullName,
    required this.role,
  });

  factory AuthUser.fromJson(Map<String, dynamic> j) => AuthUser(
    id: j['id'] as int,
    username: j['username'] as String,
    fullName: j['full_name'] as String?,
    role: j['role'] as String,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'username': username,
    'full_name': fullName,
    'role': role,
  };
}

class AuthService extends ChangeNotifier {
  static const _kToken = 'pos_token';
  static const _kUser = 'pos_user';

  String? _token;
  AuthUser? _user;

  String? get token => _token;
  AuthUser? get user => _user;
  bool get isLoggedIn => _token != null && _user != null;

  Future<void> bootstrap({bool restoreSession = true}) async {
    final p = await SharedPreferences.getInstance();
    if (!restoreSession) {
      _token = null;
      _user = null;
      await p.remove(_kToken);
      await p.remove(_kUser);
      notifyListeners();
      return;
    }
    _token = p.getString(_kToken);
    final raw = p.getString(_kUser);
    if (raw != null) {
      try {
        _user = AuthUser.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      } catch (_) {
        _user = null;
        _token = null;
      }
    }
    notifyListeners();
  }

  Future<void> ensureStaffSession() async {
    if (isLoggedIn) return;
    final res = await http
        .post(Uri.parse('${AppConfig.apiBase}/api/auth/staff-session'))
        .timeout(const Duration(seconds: 5));
    if (res.statusCode != 200) {
      String msg = 'staff session failed';
      try {
        msg = (jsonDecode(res.body) as Map)['error']?.toString() ?? msg;
      } catch (_) {}
      throw Exception(msg);
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    _token = body['token'] as String;
    _user = AuthUser.fromJson(body['user'] as Map<String, dynamic>);
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, _token!);
    await p.setString(_kUser, jsonEncode(_user!.toJson()));
    notifyListeners();
  }

  Future<void> login(String username, String password) async {
    final res = await http.post(
      Uri.parse('${AppConfig.apiBase}/api/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );
    if (res.statusCode != 200) {
      String msg = 'login failed';
      try {
        msg = (jsonDecode(res.body) as Map)['error']?.toString() ?? msg;
      } catch (_) {}
      throw Exception(msg);
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    _token = body['token'] as String;
    _user = AuthUser.fromJson(body['user'] as Map<String, dynamic>);
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, _token!);
    await p.setString(_kUser, jsonEncode(_user!.toJson()));
    notifyListeners();
  }

  Future<void> logout() async {
    _token = null;
    _user = null;
    final p = await SharedPreferences.getInstance();
    await p.remove(_kToken);
    await p.remove(_kUser);
    notifyListeners();
  }
}

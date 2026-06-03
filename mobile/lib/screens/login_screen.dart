import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config.dart';
import '../models/product.dart';
import '../services/auth_service.dart';
import 'settings_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _userCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _loading = false;
  bool _loadingStores = true;
  bool _obscurePassword = true;
  List<PosStore> _stores = const [];
  int? _selectedStoreId;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadStores();
  }

  @override
  void dispose() {
    _userCtrl.dispose();
    _passCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadStores() async {
    setState(() {
      _loadingStores = true;
      _error = null;
    });
    try {
      final stores = await context.read<AuthService>().loginStores();
      if (!mounted) return;
      final activeStores = stores.where((store) => store.isActive).toList();
      setState(() {
        _stores = activeStores;
        _selectedStoreId =
            activeStores.any((store) => store.id == _selectedStoreId)
            ? _selectedStoreId
            : (activeStores.isNotEmpty ? activeStores.first.id : null);
        _loadingStores = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stores = const [];
        _selectedStoreId = null;
        _loadingStores = false;
        _error = _friendlyError(e);
      });
    }
  }

  Future<void> _login() async {
    if (_loading || _loadingStores || _selectedStoreId == null) return;
    final username = _userCtrl.text.trim();
    final password = _passCtrl.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _error = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (AppConfig.isMobileLocalhostBase) {
        throw Exception(_serverUrlMessage());
      }
      final auth = context.read<AuthService>();
      await auth.login(username, password, storeId: _selectedStoreId);

      final role = auth.user?.role;
      if (role == null ||
          (role != 'admin' &&
              role != 'super_admin' &&
              role != 'staff' &&
              role != 'kitchen')) {
        await auth.logout();
        throw Exception('บัญชีนี้ไม่มีสิทธิ์เข้า mobile app');
      }
      if (role == 'super_admin' && AppConfig.isPublicRemoteBase) {
        await auth.logout();
        throw Exception(
          'บัญชี server admin ใช้นอกวง LAN ไม่ได้ กรุณาใช้บัญชี store admin สำหรับ mobile',
        );
      }
      if (role == 'admin' &&
          AppConfig.isPublicRemoteBase &&
          auth.user?.isMobileStoreAdmin != true) {
        await auth.logout();
        throw Exception(
          'บัญชี admin นี้ยังไม่ได้เปิดสิทธิ์ mobile store admin',
        );
      }
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openServerSettings() async {
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const SettingsScreen(closeOnSave: true),
      ),
    );
    if (mounted) {
      setState(() => _error = null);
      await _loadStores();
    }
  }

  String _serverUrlMessage() {
    return 'มือถือไม่สามารถใช้ localhost ได้ กรุณาตั้งค่า Server เป็น LAN IP หรือ Public URL เช่น http://192.168.1.10:4000 / https://xxxxx.ngrok-free.dev';
  }

  String _friendlyError(Object e) {
    final raw = e.toString();
    if (raw.contains('HandshakeException')) {
      return 'เชื่อมต่อ Server แบบ HTTPS ไม่สำเร็จ: ถ้าใช้ LAN ให้ตั้งเป็น http://192.168.x.x:4000 ถ้าใช้ ngrok ให้ตรวจว่า tunnel ยังรันอยู่';
    }
    if (raw.contains('localhost') ||
        raw.contains('Connection refused') ||
        raw.contains('SocketException')) {
      return _serverUrlMessage();
    }
    return raw.replaceFirst('Exception: ', '');
  }

  @override
  Widget build(BuildContext context) {
    final server = AppConfig.apiBase;
    return Scaffold(
      appBar: AppBar(
        title: const Text('POS V2 Login'),
        backgroundColor: const Color(0xFF1A1A2E),
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(
                    Icons.point_of_sale,
                    size: 58,
                    color: Color(0xFF1A1A2E),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'เข้าสู่ระบบร้าน',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'ใช้บัญชี admin / staff / kitchen ตามสิทธิ์ของร้านที่เลือก',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, color: Colors.grey[700]),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    server,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: AppConfig.isMobileLocalhostBase
                          ? Colors.red
                          : Colors.grey[700],
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFEBEE),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFFE57373)),
                      ),
                      child: Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          color: Colors.red,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 20),
                  _storeSelector(),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _userCtrl,
                    textInputAction: TextInputAction.next,
                    enabled: !_loading,
                    decoration: const InputDecoration(
                      labelText: 'ชื่อผู้ใช้',
                      hintText: 'admin / staff / kitchen',
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.person),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _passCtrl,
                    obscureText: _obscurePassword,
                    enabled: !_loading,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _login(),
                    decoration: InputDecoration(
                      labelText: 'รหัสผ่าน',
                      border: const OutlineInputBorder(),
                      prefixIcon: const Icon(Icons.lock),
                      suffixIcon: IconButton(
                        tooltip: _obscurePassword
                            ? 'แสดงรหัสผ่าน'
                            : 'ซ่อนรหัสผ่าน',
                        onPressed: () => setState(
                          () => _obscurePassword = !_obscurePassword,
                        ),
                        icon: Icon(
                          _obscurePassword
                              ? Icons.visibility
                              : Icons.visibility_off,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed:
                        _loading || _loadingStores || _selectedStoreId == null
                        ? null
                        : _login,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF1A1A2E),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    icon: _loading
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.login),
                    label: const Text('เข้าสู่ระบบ'),
                  ),
                  if (!_loadingStores && _stores.isEmpty) ...[
                    const SizedBox(height: 10),
                    OutlinedButton.icon(
                      onPressed: _loadStores,
                      icon: const Icon(Icons.refresh),
                      label: const Text('โหลดรายชื่อร้านอีกครั้ง'),
                    ),
                  ],
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: _openServerSettings,
                    icon: const Icon(Icons.search),
                    label: const Text('สแกน / ตั้งค่า Server'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _storeSelector() {
    if (_loadingStores) {
      return const InputDecorator(
        decoration: InputDecoration(
          labelText: 'เลือกร้านที่จะเข้าใช้งาน',
          border: OutlineInputBorder(),
          prefixIcon: Icon(Icons.storefront),
        ),
        child: Row(
          children: [
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 12),
            Text('กำลังโหลดรายชื่อร้าน...'),
          ],
        ),
      );
    }
    if (_stores.isEmpty) {
      return const InputDecorator(
        decoration: InputDecoration(
          labelText: 'เลือกร้านที่จะเข้าใช้งาน',
          border: OutlineInputBorder(),
          prefixIcon: Icon(Icons.storefront),
        ),
        child: Text('ยังโหลดรายชื่อร้านไม่ได้'),
      );
    }
    return DropdownButtonFormField<int>(
      value: _selectedStoreId,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: 'เลือกร้านที่จะเข้าใช้งาน',
        border: OutlineInputBorder(),
        prefixIcon: Icon(Icons.storefront),
      ),
      items: [
        for (final store in _stores)
          DropdownMenuItem<int>(
            value: store.id,
            child: Text(
              '${store.logo?.isNotEmpty == true ? store.logo! : "ร้าน"} ${store.name} (#${store.id})',
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
      onChanged: (value) => setState(() => _selectedStoreId = value),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config.dart';
import '../models/product.dart';
import '../services/auth_service.dart';
import '../theme.dart';
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
      body: DecoratedBox(
        decoration: const BoxDecoration(gradient: PosColors.navyGradient),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Container(
                  padding: const EdgeInsets.fromLTRB(24, 28, 24, 22),
                  decoration: BoxDecoration(
                    color: PosColors.surface,
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x40101026),
                        blurRadius: 44,
                        offset: Offset(0, 22),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Center(
                        child: Container(
                          width: 68,
                          height: 68,
                          decoration: BoxDecoration(
                            color: PosColors.accentSoft,
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: const Icon(
                            Icons.point_of_sale,
                            size: 34,
                            color: PosColors.accentDark,
                          ),
                        ),
                      ),
                      const SizedBox(height: 14),
                      const Text(
                        'เข้าสู่ระบบร้าน',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 23,
                          fontWeight: FontWeight.w800,
                          color: PosColors.navy1,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'ใช้บัญชี admin / staff / kitchen ตามสิทธิ์ของร้านที่เลือก',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 13, color: PosColors.muted),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        server,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 11.5,
                          color: AppConfig.isMobileLocalhostBase
                              ? PosColors.red
                              : PosColors.muted,
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 16),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: PosColors.redSoft,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: const Color(0x40E5476B)),
                          ),
                          child: Text(
                            _error!,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: PosColors.redDark,
                              fontWeight: FontWeight.w700,
                              fontSize: 13,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 18),
                      _storeSelector(),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _userCtrl,
                        textInputAction: TextInputAction.next,
                        enabled: !_loading,
                        decoration: const InputDecoration(
                          labelText: 'ชื่อผู้ใช้',
                          hintText: 'admin / staff / kitchen',
                          prefixIcon: Icon(Icons.person_outline),
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
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            tooltip: _obscurePassword
                                ? 'แสดงรหัสผ่าน'
                                : 'ซ่อนรหัสผ่าน',
                            onPressed: () => setState(
                              () => _obscurePassword = !_obscurePassword,
                            ),
                            icon: Icon(
                              _obscurePassword
                                  ? Icons.visibility_outlined
                                  : Icons.visibility_off_outlined,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 18),
                      _primaryButton(),
                      if (!_loadingStores && _stores.isEmpty) ...[
                        const SizedBox(height: 10),
                        OutlinedButton.icon(
                          onPressed: _loadStores,
                          icon: const Icon(Icons.refresh),
                          label: const Text('โหลดรายชื่อร้านอีกครั้ง'),
                        ),
                      ],
                      const SizedBox(height: 10),
                      TextButton.icon(
                        onPressed: _openServerSettings,
                        icon: const Icon(Icons.dns_outlined, size: 18),
                        label: const Text('สแกน / ตั้งค่า Server'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _primaryButton() {
    final disabled = _loading || _loadingStores || _selectedStoreId == null;
    return Opacity(
      opacity: disabled ? 0.5 : 1,
      child: Material(
        color: Colors.transparent,
        child: Ink(
          decoration: BoxDecoration(
            gradient: PosColors.accentGradient,
            borderRadius: BorderRadius.circular(13),
            boxShadow: const [
              BoxShadow(
                color: Color(0x59E85D04),
                blurRadius: 20,
                offset: Offset(0, 10),
              ),
            ],
          ),
          child: InkWell(
            borderRadius: BorderRadius.circular(13),
            onTap: disabled ? null : _login,
            child: Container(
              height: 52,
              alignment: Alignment.center,
              child: _loading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.4,
                        color: Colors.white,
                      ),
                    )
                  : const Text(
                      'เข้าสู่ระบบ',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 15.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.3,
                      ),
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
          prefixIcon: Icon(Icons.storefront_outlined),
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
          prefixIcon: Icon(Icons.storefront_outlined),
        ),
        child: Text('ยังโหลดรายชื่อร้านไม่ได้'),
      );
    }
    return DropdownButtonFormField<int>(
      value: _selectedStoreId,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: 'เลือกร้านที่จะเข้าใช้งาน',
        prefixIcon: Icon(Icons.storefront_outlined),
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

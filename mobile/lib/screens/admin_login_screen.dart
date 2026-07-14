import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config.dart';
import '../models/product.dart';
import '../services/auth_service.dart';

class AdminLoginScreen extends StatefulWidget {
  final int? initialStoreId;
  const AdminLoginScreen({super.key, this.initialStoreId});

  @override
  State<AdminLoginScreen> createState() => _AdminLoginScreenState();
}

class _AdminLoginScreenState extends State<AdminLoginScreen> {
  final _userCtrl = TextEditingController();
  final _passCtrl = TextEditingController();
  bool _loading = false;
  bool _loadingStores = true;
  List<PosStore> _stores = const [];
  int? _selectedStoreId;
  String? _error;

  @override
  void initState() {
    super.initState();
    _selectedStoreId = widget.initialStoreId;
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
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _login() async {
    if (_loading || _selectedStoreId == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final auth = context.read<AuthService>();
      await auth.login(
        _userCtrl.text.trim(),
        _passCtrl.text,
        storeId: _selectedStoreId,
      );
      final role = auth.user?.role;
      if (role == 'staff') {
        await auth.logout();
        throw Exception('บัญชี staff ให้เข้าสู่ระบบจากหน้า Login หลัก');
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
      if (role != 'admin' && role != 'super_admin' && role != 'kitchen') {
        await auth.logout();
        throw Exception('บัญชีนี้ไม่มีสิทธิ์เข้า admin/kitchen');
      }
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin Login'),
        backgroundColor: const Color(0xFF1C2342),
        foregroundColor: Colors.white,
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(
                  Icons.admin_panel_settings,
                  size: 56,
                  color: Color(0xFF1C2342),
                ),
                const SizedBox(height: 12),
                const Text(
                  'เข้าสู่ระบบแอดมิน / ครัว',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 24),
                _storeSelector(),
                const SizedBox(height: 12),
                TextField(
                  controller: _userCtrl,
                  autofocus: true,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'ชื่อผู้ใช้',
                    hintText: 'store admin / kitchen',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _passCtrl,
                  obscureText: true,
                  onSubmitted: (_) => _login(),
                  decoration: const InputDecoration(
                    labelText: 'รหัสผ่าน',
                    border: OutlineInputBorder(),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.red,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed:
                      _loading || _loadingStores || _selectedStoreId == null
                      ? null
                      : _login,
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF1C2342),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                  child: _loading
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('เข้าสู่ระบบ'),
                ),
                if (!_loadingStores && _stores.isEmpty) ...[
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: _loadStores,
                    icon: const Icon(Icons.refresh),
                    label: const Text('โหลดรายชื่อร้านอีกครั้ง'),
                  ),
                ],
              ],
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
          labelText: 'เลือกร้านที่จะจัดการ',
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
          labelText: 'เลือกร้านที่จะจัดการ',
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
        labelText: 'เลือกร้านที่จะจัดการ',
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

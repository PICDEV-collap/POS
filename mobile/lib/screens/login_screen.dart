import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config.dart';
import '../services/auth_service.dart';
import 'admin_login_screen.dart';
import 'settings_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _loadingStaff = false;
  String? _error;

  Future<void> _openStaff() async {
    if (_loadingStaff) return;
    setState(() {
      _loadingStaff = true;
      _error = null;
    });
    try {
      if (AppConfig.isMobileLocalhostBase) {
        throw Exception(_serverUrlMessage());
      }
      await context.read<AuthService>().ensureStaffSession();
    } catch (e) {
      if (mounted) setState(() => _error = _friendlyError(e));
    } finally {
      if (mounted) setState(() => _loadingStaff = false);
    }
  }

  Future<void> _openServerSettings() async {
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const SettingsScreen(closeOnSave: true),
      ),
    );
    if (mounted) setState(() => _error = null);
  }

  Future<void> _openAdminLogin() async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => const AdminLoginScreen()));
  }

  String _serverUrlMessage() {
    return 'มือถือไม่สามารถใช้ localhost ได้ กรุณาสแกน/ตั้งค่า Server เป็น IP เครื่องหลัก เช่น http://192.168.1.10:4000';
  }

  String _friendlyError(Object e) {
    final raw = e.toString();
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
                    'เข้าสู่ระบบเมื่อพร้อมใช้งาน',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
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
                  FilledButton.icon(
                    onPressed: _loadingStaff ? null : _openStaff,
                    style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF1A1A2E),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    icon: _loadingStaff
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.restaurant),
                    label: const Text('เข้าใช้งาน Staff'),
                  ),
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: _openAdminLogin,
                    icon: const Icon(Icons.admin_panel_settings),
                    label: const Text('Admin / Kitchen Login'),
                  ),
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
}

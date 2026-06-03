import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../models/order.dart';
import '../models/product.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/socket_service.dart';
import 'bluetooth_printer_settings.dart';

const _kNavy = Color(0xFF1A1A2E);
const _kGold = Color(0xFFFFD166);

const _statusLabel = {
  'pending': 'รอ',
  'cooking': 'กำลังทำ',
  'served': 'เสิร์ฟแล้ว',
  'paid': 'ชำระแล้ว',
  'cancelled': 'ยกเลิก',
};
const _statusColor = {
  'pending': Color(0xFFFF6B6B),
  'cooking': Color(0xFFFFD166),
  'served': Color(0xFF06D6A0),
  'paid': Color(0xFF888888),
};

String _trimOrderRoot(String value) {
  return value
      .trim()
      .replaceFirst(RegExp(r'/order/?$'), '')
      .replaceFirst(RegExp(r'/$'), '');
}

bool _isLanLikeUrl(String value) {
  final uri = Uri.tryParse(_trimOrderRoot(value));
  final host = uri?.host.toLowerCase() ?? '';
  if (host.isEmpty) return false;
  if (host == 'localhost' || host.startsWith('127.')) return true;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
  final m = RegExp(r'^172\.(\d{1,2})\.').firstMatch(host);
  final octet = int.tryParse(m?.group(1) ?? '');
  return octet != null && octet >= 16 && octet <= 31;
}

String _localCustomerWebRoot() {
  final uri = Uri.tryParse(AppConfig.apiBase);
  if (uri == null)
    return _trimOrderRoot(AppConfig.apiBase.replaceAll(':4000', ':3000'));
  final webUri = uri.hasPort && uri.port == 4000
      ? uri.replace(port: 3000)
      : uri;
  return _trimOrderRoot(webUri.origin);
}

class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});
  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tab;
  late ApiService _api;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 8, vsync: this);
    _api = ApiService(context.read<AuthService>());
    context.read<SocketService>().connect();
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  Future<void> _logout() async {
    await context.read<AuthService>().logout();
    context.read<SocketService>().disconnect();
  }

  Future<void> _openWebAdmin() async {
    final url = Uri.parse(
      '${AppConfig.apiBase.replaceAll(':4000', ':3000')}/admin',
    );
    if (await canLaunchUrl(url))
      await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final storeScopeKey = auth.activeStoreId ?? auth.user?.storeId ?? 1;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          'Admin · ${auth.user?.fullName ?? auth.user?.username ?? ""}',
        ),
        backgroundColor: _kNavy,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'web admin',
            onPressed: _openWebAdmin,
            icon: const Icon(Icons.open_in_browser),
          ),
          IconButton(onPressed: _logout, icon: const Icon(Icons.logout)),
        ],
        bottom: TabBar(
          controller: _tab,
          isScrollable: true,
          indicatorColor: _kGold,
          labelColor: Colors.white,
          unselectedLabelColor: Colors.white70,
          tabs: const [
            Tab(icon: Icon(Icons.dashboard, size: 18), text: 'ภาพรวม'),
            Tab(icon: Icon(Icons.storefront, size: 18), text: 'ร้าน'),
            Tab(icon: Icon(Icons.list_alt, size: 18), text: 'ออเดอร์'),
            Tab(icon: Icon(Icons.fastfood, size: 18), text: 'เมนู'),
            Tab(icon: Icon(Icons.category, size: 18), text: 'หมวด'),
            Tab(icon: Icon(Icons.table_restaurant, size: 18), text: 'โต๊ะ/QR'),
            Tab(icon: Icon(Icons.print, size: 18), text: 'พิมพ์'),
            Tab(icon: Icon(Icons.settings, size: 18), text: 'ตั้งค่า'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tab,
        children: [
          KeyedSubtree(
            key: ValueKey('dashboard-$storeScopeKey'),
            child: _DashboardTab(api: _api),
          ),
          _StoresTab(api: _api),
          KeyedSubtree(
            key: ValueKey('orders-$storeScopeKey'),
            child: _OrdersTab(api: _api),
          ),
          KeyedSubtree(
            key: ValueKey('products-$storeScopeKey'),
            child: _ProductsTab(api: _api),
          ),
          KeyedSubtree(
            key: ValueKey('categories-$storeScopeKey'),
            child: _CategoriesTab(api: _api),
          ),
          KeyedSubtree(
            key: ValueKey('tables-$storeScopeKey'),
            child: _TablesTab(api: _api),
          ),
          KeyedSubtree(
            key: ValueKey('printer-$storeScopeKey'),
            child: _PrinterTab(api: _api),
          ),
          KeyedSubtree(
            key: ValueKey('settings-$storeScopeKey'),
            child: _SettingsTab(api: _api),
          ),
        ],
      ),
    );
  }
}

// ─── Stores / branches ──────────────────────────────────────────────────
class _StoresTab extends StatefulWidget {
  final ApiService api;
  const _StoresTab({required this.api});
  @override
  State<_StoresTab> createState() => _StoresTabState();
}

class _StoresTabState extends State<_StoresTab> {
  List<PosStore> _stores = [];
  bool _loading = true;
  int? _deletingId;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<List<PosStore>> _reload() async {
    try {
      final list = await widget.api.stores();
      if (!mounted) return list;
      setState(() {
        _stores = list;
        _loading = false;
      });
      return list;
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_friendlyStoreError(e))));
        setState(() => _loading = false);
      }
      return _stores;
    }
  }

  String _friendlyStoreError(Object e) {
    final text = e.toString();
    if (text.contains('cannot delete default store')) {
      return 'ไม่สามารถลบร้านหลักได้';
    }
    if (text.contains('store is assigned to users')) {
      return 'ร้านนี้ยังมีผู้ใช้งานผูกอยู่ ต้องย้ายผู้ใช้ก่อนลบ';
    }
    if (text.contains('store has transaction history')) {
      return 'ร้านนี้มีประวัติขาย/สต๊อก/บัญชีแล้ว จึงลบถาวรไม่ได้';
    }
    if (text.contains('store has printer stations')) {
      return 'ร้านนี้ยังมีจุดพิมพ์ที่ถูกใช้งานอยู่';
    }
    if (text.contains('store access forbidden')) {
      return 'ไม่มีสิทธิ์จัดการร้านนี้';
    }
    return text;
  }

  Future<void> _selectStore(PosStore store) async {
    await context.read<AuthService>().setActiveStoreId(store.id);
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('กำลังจัดการร้าน "${store.name}"')));
  }

  Future<bool?> _confirmDelete(PosStore store) => showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('ลบร้าน?'),
      content: Text(
        'ลบร้าน "${store.name}"?\n\nระบบจะลบเฉพาะร้านที่ยังไม่มีประวัติขาย/สต๊อก/บัญชีเท่านั้น และจะลบโต๊ะ QR หมวด และเมนูของร้านนี้ด้วย',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('ยกเลิก'),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.red,
            foregroundColor: Colors.white,
          ),
          onPressed: () => Navigator.pop(context, true),
          child: const Text('ลบ'),
        ),
      ],
    ),
  );

  Future<void> _deleteStore(PosStore store) async {
    if (store.isDefault) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('ไม่สามารถลบร้านหลักได้')));
      return;
    }
    final auth = context.read<AuthService>();
    final ok = await _confirmDelete(store);
    if (!mounted) return;
    if (ok != true) return;
    setState(() => _deletingId = store.id);
    try {
      await widget.api.deleteStore(store.id);
      final list = await _reload();
      if (auth.activeStoreId == store.id) {
        PosStore? next;
        for (final candidate in list) {
          if (candidate.isActive) {
            next = candidate;
            break;
          }
        }
        next ??= list.isNotEmpty ? list.first : null;
        if (next != null) await auth.setActiveStoreId(next.id);
      }
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('ลบร้าน "${store.name}" แล้ว')));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(_friendlyStoreError(e))));
      }
    } finally {
      if (mounted) setState(() => _deletingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final activeStoreId = context.watch<AuthService>().activeStoreId;
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _stores.isEmpty ? 1 : _stores.length,
        itemBuilder: (_, i) {
          if (_stores.isEmpty) {
            return const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: Text('ยังไม่มีร้านในระบบ')),
            );
          }
          final store = _stores[i];
          final isActiveStore = store.id == activeStoreId;
          final deleting = _deletingId == store.id;
          final user = context.read<AuthService>().user;
          final canDeleteStore =
              user?.isSuperAdmin == true && !AppConfig.isPublicRemoteBase;
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: CircleAvatar(
                      backgroundColor: isActiveStore
                          ? _kNavy
                          : Colors.grey[200],
                      foregroundColor: isActiveStore ? _kGold : _kNavy,
                      child: Text(
                        (store.logo == null || store.logo!.isEmpty)
                            ? '🏬'
                            : store.logo!,
                      ),
                    ),
                    title: Text(
                      store.name,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                    subtitle: Text(
                      '${store.code} · #${store.id}\n${store.publicBaseUrl?.isNotEmpty == true ? store.publicBaseUrl! : "LAN/local only"}',
                    ),
                    isThreeLine: true,
                    trailing: store.isDefault
                        ? const Icon(Icons.lock, color: Colors.grey)
                        : (store.isActive
                              ? const Icon(
                                  Icons.check_circle,
                                  color: Color(0xFF05795C),
                                )
                              : const Icon(
                                  Icons.pause_circle,
                                  color: Colors.orange,
                                )),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: isActiveStore ? _kNavy : null,
                            foregroundColor: isActiveStore
                                ? Colors.white
                                : null,
                          ),
                          onPressed: deleting
                              ? null
                              : () => _selectStore(store),
                          icon: Icon(
                            isActiveStore
                                ? Icons.radio_button_checked
                                : Icons.storefront,
                          ),
                          label: Text(
                            isActiveStore
                                ? 'กำลังจัดการร้านนี้'
                                : 'จัดการร้านนี้',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.red,
                        ),
                        onPressed:
                            store.isDefault || deleting || !canDeleteStore
                            ? null
                            : () => _deleteStore(store),
                        icon: deleting
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.delete_outline),
                        label: const Text('ลบ'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

// ─── Dashboard ──────────────────────────────────────────────────────────
class _DashboardTab extends StatefulWidget {
  final ApiService api;
  const _DashboardTab({required this.api});
  @override
  State<_DashboardTab> createState() => _DashboardTabState();
}

class _DashboardTabState extends State<_DashboardTab> {
  List<PosOrder> _orders = [];
  bool _loading = true;
  String? _err;

  @override
  void initState() {
    super.initState();
    _reload();
    final s = context.read<SocketService>();
    s.on('order:new', _onEvt);
    s.on('order:update', _onEvt);
  }

  @override
  void dispose() {
    final s = context.read<SocketService>();
    s.off('order:new', _onEvt);
    s.off('order:update', _onEvt);
    super.dispose();
  }

  void _onEvt(_) => _reload();

  Future<void> _reload() async {
    try {
      final list = await widget.api.listOrders(includeDetails: false);
      if (!mounted) return;
      setState(() {
        _orders = list;
        _loading = false;
        _err = null;
      });
    } catch (e) {
      if (mounted)
        setState(() {
          _err = e.toString();
          _loading = false;
        });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_err != null)
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _err!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: Colors.red,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'Server: ${AppConfig.apiBase}\nBuild: ${AppConfig.buildLabel}',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: Colors.grey[700]),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () {
                  setState(() {
                    _loading = true;
                    _err = null;
                  });
                  _reload();
                },
                icon: const Icon(Icons.refresh),
                label: const Text('ลองใหม่'),
              ),
            ],
          ),
        ),
      );
    final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
    final todayOrders = _orders
        .where(
          (o) =>
              DateFormat('yyyy-MM-dd').format(o.createdAt.toLocal()) == today,
        )
        .toList();
    final active = _orders
        .where((o) => ['pending', 'cooking', 'served'].contains(o.status))
        .length;
    final revenue = todayOrders
        .where((o) => o.status == 'paid')
        .fold<double>(0, (s, o) => s + o.totalAmount);
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _statCard('ออเดอร์วันนี้', '${todayOrders.length}', '📋'),
          _statCard(
            'ยอดขายวันนี้',
            '฿${revenue.toStringAsFixed(0)}',
            '💰',
            highlight: true,
          ),
          _statCard('กำลังดำเนินการ', '$active', '⏳'),
          _statCard('ออเดอร์ทั้งหมด', '${_orders.length}', '📦'),
        ],
      ),
    );
  }

  Widget _statCard(
    String label,
    String value,
    String icon, {
    bool highlight = false,
  }) {
    return Card(
      color: highlight ? _kNavy : Colors.white,
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Text(icon, style: const TextStyle(fontSize: 28)),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 14,
                  color: highlight ? Colors.white70 : Colors.grey[700],
                ),
              ),
            ),
            Text(
              value,
              style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.w800,
                color: highlight ? _kGold : _kNavy,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Orders ────────────────────────────────────────────────────────────
class _OrdersTab extends StatefulWidget {
  final ApiService api;
  const _OrdersTab({required this.api});
  @override
  State<_OrdersTab> createState() => _OrdersTabState();
}

class _OrdersTabState extends State<_OrdersTab> {
  List<PosOrder> _orders = [];
  String _filter = 'active';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
    final s = context.read<SocketService>();
    s.on('order:new', _onEvt);
    s.on('order:update', _onEvt);
  }

  @override
  void dispose() {
    final s = context.read<SocketService>();
    s.off('order:new', _onEvt);
    s.off('order:update', _onEvt);
    super.dispose();
  }

  void _onEvt(_) => _reload();

  Future<void> _reload() async {
    try {
      final list = await widget.api.listOrders(includeDetails: false);
      if (!mounted) return;
      setState(() {
        _orders = list;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
      setState(() {
        _loading = false;
      });
    }
  }

  Future<void> _changeStatus(int id, String status) async {
    try {
      await widget.api.updateOrderStatus(id, status);
      _reload();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final filtered = switch (_filter) {
      'all' => _orders,
      'paid' => _orders.where((o) => o.status == 'paid').toList(),
      'active' =>
        _orders
            .where((o) => ['pending', 'cooking', 'served'].contains(o.status))
            .toList(),
      _ => _orders,
    };
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: Colors.grey[100],
          child: Row(
            children: [
              for (final f in const [
                ['active', 'กำลังดำเนินการ'],
                ['paid', 'ชำระแล้ว'],
                ['all', 'ทั้งหมด'],
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    label: Text(f[1]),
                    selected: _filter == f[0],
                    onSelected: (_) => setState(() => _filter = f[0]),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _reload,
            child: filtered.isEmpty
                ? const Center(
                    child: Text(
                      'ไม่มีข้อมูล',
                      style: TextStyle(color: Colors.grey),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(8),
                    itemCount: filtered.length,
                    itemBuilder: (_, i) {
                      final o = filtered[i];
                      final c = _statusColor[o.status] ?? Colors.grey;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 8),
                        child: ListTile(
                          leading: CircleAvatar(
                            backgroundColor: c,
                            foregroundColor: _kNavy,
                            child: Text(
                              '#${o.id}',
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          title: Text(
                            '${o.tableName} · ${o.itemCount} รายการ',
                            style: const TextStyle(fontWeight: FontWeight.bold),
                          ),
                          subtitle: Text(
                            '${_statusLabel[o.status] ?? o.status} · ฿${o.totalAmount.toStringAsFixed(0)} · ${DateFormat('HH:mm').format(o.createdAt.toLocal())}',
                          ),
                          trailing: PopupMenuButton<String>(
                            icon: const Icon(Icons.more_vert),
                            onSelected: (v) => _changeStatus(o.id, v),
                            itemBuilder: (_) => const [
                              PopupMenuItem(
                                value: 'cooking',
                                child: Text('▶ กำลังทำ'),
                              ),
                              PopupMenuItem(
                                value: 'served',
                                child: Text('✅ เสิร์ฟแล้ว'),
                              ),
                              PopupMenuItem(
                                value: 'paid',
                                child: Text('💰 ชำระแล้ว'),
                              ),
                              PopupMenuItem(
                                value: 'cancelled',
                                child: Text('❌ ยกเลิก'),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}

// ─── Products CRUD ──────────────────────────────────────────────────────
class _ProductsTab extends StatefulWidget {
  final ApiService api;
  const _ProductsTab({required this.api});
  @override
  State<_ProductsTab> createState() => _ProductsTabState();
}

class _ProductsTabState extends State<_ProductsTab> {
  List<Product> _products = [];
  List<Category> _categories = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
    context.read<SocketService>().on('product:availability', _onAvailEvt);
  }

  @override
  void dispose() {
    context.read<SocketService>().off('product:availability', _onAvailEvt);
    super.dispose();
  }

  void _onAvailEvt(dynamic payload) {
    if (payload is! Map) return;
    final id = payload['id'];
    final avail = payload['is_available'];
    if (id is! int || avail is! bool) return;
    if (!mounted) return;
    setState(() {
      _products = _products
          .map((p) => p.id == id ? p.copyWith(isAvailable: avail) : p)
          .toList();
    });
  }

  Future<void> _reload() async {
    try {
      final r = await Future.wait([
        widget.api.products(),
        widget.api.categories(),
      ]);
      if (!mounted) return;
      setState(() {
        _products = r[0] as List<Product>;
        _categories = r[1] as List<Category>;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
      setState(() => _loading = false);
    }
  }

  Future<void> _openBarcodePrint(Product p) async {
    if ((p.barcode ?? '').isEmpty) return;
    final result = await showDialog<bool>(
      context: context,
      builder: (_) => _BarcodePrintDialog(api: widget.api, product: p),
    );
    if (result == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('ส่งคิวพิมพ์ barcode "${p.name}" แล้ว')),
      );
    }
  }

  final Set<int> _availBusyIds = <int>{}; // double-tap guard per row
  Future<void> _toggleAvail(Product p) async {
    if (_availBusyIds.contains(p.id)) return;
    setState(() => _availBusyIds.add(p.id));
    try {
      final saved = await widget.api.setProductAvailability(
        p.id,
        isAvailable: !p.isAvailable,
      );
      final nextAvail = saved['is_available'] as bool? ?? !p.isAvailable;
      if (!mounted) return;
      setState(() {
        _products = _products
            .map((x) => x.id == p.id ? x.copyWith(isAvailable: nextAvail) : x)
            .toList();
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(nextAvail
              ? '${p.name} — เปิดขายแล้ว'
              : '${p.name} — ปิดขาย (ของหมด)'),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('เปลี่ยนสถานะไม่สำเร็จ: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _availBusyIds.remove(p.id));
    }
  }

  Future<void> _delete(Product p) async {
    final ok = await _confirm(
      'ลบเมนู "${p.name}" ออกถาวร? — ออเดอร์เก่ายังเก็บชื่อ+ราคาไว้ครบ',
    );
    if (ok != true) return;
    try {
      await widget.api.deleteProduct(p.id);
      _reload();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<bool?> _confirm(String msg) => showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      content: Text(msg),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('ยกเลิก'),
        ),
        ElevatedButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('ตกลง'),
        ),
      ],
    ),
  );

  void _openEditor([Product? p]) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) =>
          _ProductEditor(api: widget.api, initial: p, categories: _categories),
    ).then((_) => _reload());
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _reload,
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 80),
            itemCount: _products.length,
            itemBuilder: (_, i) {
              final p = _products[i];
              final cat = _categories.firstWhere(
                (c) => c.id == p.categoryId,
                orElse: () =>
                    Category(id: 0, name: '—', sortOrder: 0, isActive: true),
              );
              return Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: Opacity(
                  opacity: p.isAvailable ? 1 : .5,
                  child: ListTile(
                    leading: p.imageUrl != null
                        ? ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: Image.network(
                              widget.api.imageUrl(p.imageUrl),
                              headers: AppConfig.tunnelHeaders,
                              width: 50,
                              height: 50,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) =>
                                  _emojiAvatar(p.emoji),
                            ),
                          )
                        : _emojiAvatar(p.emoji),
                    title: Row(
                      children: [
                        Expanded(
                          child: Text(
                            p.name,
                            style: const TextStyle(fontWeight: FontWeight.bold),
                          ),
                        ),
                        if (p.isPopular)
                          const Text('🔥', style: TextStyle(fontSize: 14)),
                      ],
                    ),
                    subtitle: Text(
                      '${cat.name} · ฿${p.price.toStringAsFixed(0)}${p.variants != null ? " · ${p.variants!.length} ขนาด" : ""}',
                    ),
                    trailing: PopupMenuButton<String>(
                      icon: const Icon(Icons.more_vert),
                      onSelected: (v) {
                        if (v == 'edit')
                          _openEditor(p);
                        else if (v == 'avail')
                          _toggleAvail(p);
                        else if (v == 'barcode')
                          _openBarcodePrint(p);
                        else if (v == 'delete')
                          _delete(p);
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(
                          value: 'edit',
                          child: Text('✏️ แก้ไข'),
                        ),
                        if ((p.barcode ?? '').isNotEmpty)
                          const PopupMenuItem(
                            value: 'barcode',
                            child: Text('🖨 พิมพ์ barcode'),
                          ),
                        PopupMenuItem(
                          value: 'avail',
                          child: Text(
                            p.isAvailable ? '⛔ ปิดขาย' : '🟢 เปิดขาย',
                          ),
                        ),
                        const PopupMenuItem(
                          value: 'delete',
                          child: Text('🗑️ ลบ'),
                        ),
                      ],
                    ),
                    onTap: () => _openEditor(p),
                  ),
                ),
              );
            },
          ),
        ),
        Positioned(
          bottom: 16,
          right: 16,
          child: FloatingActionButton.extended(
            backgroundColor: _kNavy,
            foregroundColor: Colors.white,
            onPressed: () => _openEditor(),
            icon: const Icon(Icons.add),
            label: const Text('เพิ่มเมนู'),
          ),
        ),
      ],
    );
  }

  Widget _emojiAvatar(String? emoji) => CircleAvatar(
    backgroundColor: Colors.grey[200],
    child: Text(emoji ?? '🍽️', style: const TextStyle(fontSize: 22)),
  );
}

// Editor for new/existing product
class _ProductEditor extends StatefulWidget {
  final ApiService api;
  final Product? initial;
  final List<Category> categories;
  const _ProductEditor({
    required this.api,
    this.initial,
    required this.categories,
  });
  @override
  State<_ProductEditor> createState() => _ProductEditorState();
}

class _ProductEditorState extends State<_ProductEditor> {
  late TextEditingController _name, _desc, _price, _emoji;
  int? _categoryId;
  bool _isPopular = false;
  bool _saving = false;
  String? _pickedImagePath;
  String? _existingImageUrl;
  List<Variant> _variants = [];
  // Option groups are backward-compatible with legacy {name, choices} and
  // preserve advanced fields from web admin such as min/max and price_delta.
  List<OptionGroup> _optionGroups = [];

  @override
  void initState() {
    super.initState();
    final p = widget.initial;
    _name = TextEditingController(text: p?.name ?? '');
    _desc = TextEditingController(text: p?.description ?? '');
    _price = TextEditingController(text: p?.price.toStringAsFixed(0) ?? '');
    _emoji = TextEditingController(text: p?.emoji ?? '');
    _categoryId =
        p?.categoryId ??
        (widget.categories.isNotEmpty ? widget.categories.first.id : null);
    _isPopular = p?.isPopular ?? false;
    _existingImageUrl = p?.imageUrl;
    _variants = List.from(p?.variants ?? []);
    _optionGroups = List.from(p?.options ?? []);
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _price.dispose();
    _emoji.dispose();
    super.dispose();
  }

  Future<void> _pickImage(ImageSource source) async {
    try {
      final picker = ImagePicker();
      final f = await picker.pickImage(
        source: source,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );
      if (f != null) setState(() => _pickedImagePath = f.path);
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('เลือกรูปไม่ได้: $e')));
    }
  }

  void _addVariant() {
    showDialog(
      context: context,
      builder: (_) {
        final name = TextEditingController();
        final price = TextEditingController();
        return AlertDialog(
          title: const Text('เพิ่มขนาด/variant'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                decoration: const InputDecoration(
                  labelText: 'ชื่อ (เช่น เล็ก)',
                ),
              ),
              TextField(
                controller: price,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'ราคา'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('ยกเลิก'),
            ),
            ElevatedButton(
              onPressed: () {
                final p = double.tryParse(price.text);
                if (name.text.trim().isEmpty || p == null) return;
                setState(
                  () =>
                      _variants.add(Variant(name: name.text.trim(), price: p)),
                );
                Navigator.pop(context);
              },
              child: const Text('เพิ่ม'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('ใส่ชื่อเมนู')));
      return;
    }
    final priceVal = double.tryParse(_price.text);
    if (priceVal == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('ราคาต้องเป็นตัวเลข')));
      return;
    }
    setState(() => _saving = true);
    try {
      // Strip option groups with empty name or zero choices — they'd crash
      // the customer's order validation.
      final cleanGroups = _optionGroups
          .where(
            (g) =>
                g.name.trim().isNotEmpty &&
                g.items.where((c) => c.name.trim().isNotEmpty).isNotEmpty,
          )
          .map(
            (g) => g.copyWith(
              name: g.name.trim(),
              items: g.items
                  .where((c) => c.name.trim().isNotEmpty)
                  .map(
                    (c) => OptionItem(
                      id: c.id,
                      name: c.name.trim(),
                      priceDelta: c.priceDelta,
                      isDefault: c.isDefault,
                      isAvailable: c.isAvailable,
                      sortOrder: c.sortOrder,
                    ),
                  )
                  .toList(),
            ),
          )
          .toList();
      final body = {
        'category_id': _categoryId,
        'name': _name.text.trim(),
        'description': _desc.text.trim().isEmpty ? null : _desc.text.trim(),
        'price': priceVal,
        'emoji': _emoji.text.trim().isEmpty ? null : _emoji.text.trim(),
        'is_popular': _isPopular,
        'variants': _variants.isEmpty
            ? null
            : _variants.map((v) => v.toJson()).toList(),
        'options': cleanGroups.isEmpty
            ? null
            : cleanGroups.map((g) => g.toJson()).toList(),
      };
      Product saved;
      if (widget.initial != null) {
        saved = await widget.api.updateProduct(widget.initial!.id, body);
      } else {
        saved = await widget.api.createProduct(body);
      }
      if (_pickedImagePath != null) {
        await widget.api.uploadProductImage(saved.id, _pickedImagePath!);
      }
      if (!mounted) return;
      Navigator.pop(context);
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.85,
      maxChildSize: 0.95,
      minChildSize: 0.5,
      expand: false,
      builder: (_, controller) => Container(
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        padding: EdgeInsets.only(
          left: 16,
          right: 16,
          top: 12,
          bottom: MediaQuery.of(context).viewInsets.bottom + 16,
        ),
        child: ListView(
          controller: controller,
          children: [
            Center(
              child: Container(width: 40, height: 4, color: Colors.grey[300]),
            ),
            const SizedBox(height: 12),
            Text(
              widget.initial != null ? 'แก้ไขเมนู' : 'เพิ่มเมนูใหม่',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 16),
            // Image picker
            Row(
              children: [
                _imagePreview(),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      OutlinedButton.icon(
                        onPressed: () => _pickImage(ImageSource.camera),
                        icon: const Icon(Icons.camera_alt),
                        label: const Text('ถ่ายรูป'),
                      ),
                      const SizedBox(height: 6),
                      OutlinedButton.icon(
                        onPressed: () => _pickImage(ImageSource.gallery),
                        icon: const Icon(Icons.photo_library),
                        label: const Text('เลือกจากแกลเลอรี'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                labelText: 'ชื่อเมนู *',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _emoji,
              decoration: const InputDecoration(
                labelText: 'Emoji (เช่น 🍜)',
                border: OutlineInputBorder(),
              ),
              maxLength: 4,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _desc,
              decoration: const InputDecoration(
                labelText: 'คำอธิบาย',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _price,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'ราคา *',
                      border: OutlineInputBorder(),
                      prefixText: '฿',
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<int?>(
                    initialValue: _categoryId,
                    decoration: const InputDecoration(
                      labelText: 'หมวด',
                      border: OutlineInputBorder(),
                    ),
                    items: widget.categories
                        .map(
                          (c) => DropdownMenuItem(
                            value: c.id,
                            child: Text('${c.icon ?? ""} ${c.name}'),
                          ),
                        )
                        .toList(),
                    onChanged: (v) => setState(() => _categoryId = v),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              value: _isPopular,
              onChanged: (v) => setState(() => _isPopular = v),
              title: const Text('🔥 เมนูยอดนิยม'),
              contentPadding: EdgeInsets.zero,
            ),
            const Divider(),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    '📐 ขนาด/Variants',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
                TextButton.icon(
                  onPressed: _addVariant,
                  icon: const Icon(Icons.add),
                  label: const Text('เพิ่ม'),
                ),
              ],
            ),
            ..._variants.map(
              (v) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(v.name),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('฿${v.price.toStringAsFixed(0)}'),
                    IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: () => setState(() => _variants.remove(v)),
                    ),
                  ],
                ),
              ),
            ),
            const Divider(),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    '🎛️ ตัวเลือก (mutex)',
                    style: TextStyle(fontWeight: FontWeight.bold),
                  ),
                ),
                TextButton.icon(
                  onPressed: () => setState(
                    () => _optionGroups.add(
                      OptionGroup(name: '', choices: const []),
                    ),
                  ),
                  icon: const Icon(Icons.add),
                  label: const Text('เพิ่มกลุ่ม'),
                ),
              ],
            ),
            const Padding(
              padding: EdgeInsets.only(bottom: 6),
              child: Text(
                'แต่ละกลุ่มลูกค้าต้องเลือก 1 ตัวเลือก เช่น ประเภท: น้ำ/แห้ง · ความเผ็ด: พริก/ไม่พริก',
                style: TextStyle(fontSize: 11, color: Colors.grey),
              ),
            ),
            ..._optionGroups.asMap().entries.map(
              (e) => _optionGroupTile(e.key, e.value),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: _kNavy,
                  foregroundColor: Colors.white,
                ),
                onPressed: _saving ? null : _save,
                child: _saving
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text(
                        '💾 บันทึก',
                        style: TextStyle(fontWeight: FontWeight.bold),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _optionGroupTile(int idx, OptionGroup g) {
    final nameCtrl = TextEditingController(text: g.name);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 6, 4, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: nameCtrl,
                    decoration: const InputDecoration(
                      labelText: 'ชื่อกลุ่ม (เช่น ประเภท)',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onChanged: (v) {
                      // Replace this group with new name; keep choices.
                      _optionGroups[idx] = g.copyWith(name: v);
                    },
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.delete, color: Colors.red, size: 20),
                  tooltip: 'ลบกลุ่ม',
                  onPressed: () => setState(() => _optionGroups.removeAt(idx)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                ...g.items.asMap().entries.map(
                  (e) => InputChip(
                    label: Text(
                      e.value.priceDelta == 0
                          ? e.value.name
                          : '${e.value.name} ${e.value.priceDelta > 0 ? "+" : ""}฿${e.value.priceDelta.toStringAsFixed(0)}',
                    ),
                    onDeleted: () => setState(() {
                      final newItems = List<OptionItem>.from(g.items)
                        ..removeAt(e.key);
                      _optionGroups[idx] = g.copyWith(items: newItems);
                    }),
                  ),
                ),
                ActionChip(
                  label: const Text('+ ตัวเลือก'),
                  onPressed: () => _addChoice(idx),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _addChoice(int groupIdx) async {
    final ctrl = TextEditingController();
    final v = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(
          'เพิ่มตัวเลือกใน "${_optionGroups[groupIdx].name.isEmpty ? "กลุ่มใหม่" : _optionGroups[groupIdx].name}"',
        ),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'เช่น น้ำ, แห้ง, พริก, ไม่พริก',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('ยกเลิก'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, ctrl.text.trim()),
            child: const Text('เพิ่ม'),
          ),
        ],
      ),
    );
    if (v == null || v.isEmpty) return;
    setState(() {
      final g = _optionGroups[groupIdx];
      _optionGroups[groupIdx] = g.copyWith(
        items: [
          ...g.items,
          OptionItem(name: v, sortOrder: g.items.length),
        ],
      );
    });
  }

  Widget _imagePreview() {
    Widget child;
    if (_pickedImagePath != null) {
      child = Image.file(
        File(_pickedImagePath!),
        width: 80,
        height: 80,
        fit: BoxFit.cover,
      );
    } else if (_existingImageUrl != null) {
      child = Image.network(
        widget.api.imageUrl(_existingImageUrl),
        headers: AppConfig.tunnelHeaders,
        width: 80,
        height: 80,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Container(
          color: Colors.grey[100],
          child: const Icon(Icons.fastfood, size: 40),
        ),
      );
    } else {
      child = Container(
        color: Colors.grey[100],
        width: 80,
        height: 80,
        child: const Icon(
          Icons.add_photo_alternate,
          size: 40,
          color: Colors.grey,
        ),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(width: 80, height: 80, child: child),
    );
  }
}

// ─── Categories CRUD ───────────────────────────────────────────────────
class _CategoriesTab extends StatefulWidget {
  final ApiService api;
  const _CategoriesTab({required this.api});
  @override
  State<_CategoriesTab> createState() => _CategoriesTabState();
}

class _CategoriesTabState extends State<_CategoriesTab> {
  List<Category> _cats = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final list = await widget.api.categoriesAll();
      if (!mounted) return;
      setState(() {
        _cats = list;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
      setState(() => _loading = false);
    }
  }

  void _openEditor([Category? c]) {
    showDialog(
      context: context,
      builder: (_) => _CategoryEditor(api: widget.api, initial: c),
    ).then((_) => _reload());
  }

  Future<void> _delete(Category c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('ลบหมวด?'),
        content: Text(
          'ลบหมวด "${c.name}" ออกถาวร? — เมนูในหมวดนี้จะยังอยู่แต่ category_id เป็น null',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('ยกเลิก'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('ลบ'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.deleteCategory(c.id);
      _reload();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _reload,
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 80),
            itemCount: _cats.length,
            itemBuilder: (_, i) {
              final c = _cats[i];
              return Card(
                child: Opacity(
                  opacity: c.isActive ? 1 : .4,
                  child: ListTile(
                    leading: Text(
                      c.icon ?? '📁',
                      style: const TextStyle(fontSize: 26),
                    ),
                    title: Text(c.name),
                    subtitle: Text(
                      'order: ${c.sortOrder} · ${c.isActive ? "เปิดใช้" : "ปิด"}',
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          icon: const Icon(Icons.edit, size: 20),
                          onPressed: () => _openEditor(c),
                        ),
                        IconButton(
                          icon: const Icon(
                            Icons.delete,
                            color: Colors.red,
                            size: 20,
                          ),
                          onPressed: () => _delete(c),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        Positioned(
          bottom: 16,
          right: 16,
          child: FloatingActionButton.extended(
            backgroundColor: _kNavy,
            foregroundColor: Colors.white,
            onPressed: () => _openEditor(),
            icon: const Icon(Icons.add),
            label: const Text('เพิ่มหมวด'),
          ),
        ),
      ],
    );
  }
}

class _CategoryEditor extends StatefulWidget {
  final ApiService api;
  final Category? initial;
  const _CategoryEditor({required this.api, this.initial});
  @override
  State<_CategoryEditor> createState() => _CategoryEditorState();
}

class _CategoryEditorState extends State<_CategoryEditor> {
  late TextEditingController _name, _icon, _order;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.initial?.name ?? '');
    _icon = TextEditingController(text: widget.initial?.icon ?? '');
    _order = TextEditingController(text: '${widget.initial?.sortOrder ?? 0}');
  }

  @override
  void dispose() {
    _name.dispose();
    _icon.dispose();
    _order.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) return;
    setState(() => _saving = true);
    try {
      final body = {
        'name': _name.text.trim(),
        'icon': _icon.text.trim().isEmpty ? null : _icon.text.trim(),
        'sort_order': int.tryParse(_order.text) ?? 0,
      };
      if (widget.initial != null) {
        await widget.api.updateCategory(widget.initial!.id, body);
      } else {
        await widget.api.createCategory(body);
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.initial != null ? 'แก้ไขหมวด' : 'เพิ่มหมวด'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'ชื่อ'),
          ),
          TextField(
            controller: _icon,
            maxLength: 4,
            decoration: const InputDecoration(labelText: 'Icon (emoji)'),
          ),
          TextField(
            controller: _order,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'ลำดับ'),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('ยกเลิก'),
        ),
        ElevatedButton(
          onPressed: _saving ? null : _save,
          child: const Text('บันทึก'),
        ),
      ],
    );
  }
}

// ─── Tables CRUD + QR ──────────────────────────────────────────────────
class _TablesTab extends StatefulWidget {
  final ApiService api;
  const _TablesTab({required this.api});
  @override
  State<_TablesTab> createState() => _TablesTabState();
}

class _TablesTabState extends State<_TablesTab> {
  List<PosTable> _tables = [];
  bool _loading = true;
  String _baseUrl = '';
  String? _publicBase; // from backend PUBLIC_BASE_URL
  bool _wifiOnlyQr = false;
  bool _rotatingAll = false;
  final Set<int> _printingTableIds = <int>{}; // double-tap guard per-row

  @override
  void initState() {
    super.initState();
    _baseUrl = '${_localCustomerWebRoot()}/order';
    _resolvePublicBase();
    _reload();
  }

  /// Use LAN QR when ordering is WiFi/LAN-only. Otherwise use backend's
  /// public_base_url (Caddy/ngrok) when available and fall back to LAN.
  Future<void> _resolvePublicBase() async {
    var wifiOnly = false;
    String? pub;
    try {
      final settings = await widget.api.getSettings();
      wifiOnly = settings.orderingRequirePrivateIp;
    } catch (_) {
      /* keep safe LAN fallback */
    }
    try {
      final info = await widget.api.getDiscoveryInfo();
      pub = info['public_base_url'] as String?;
    } catch (_) {
      /* offline or backend down — keep LAN fallback */
    }
    if (!mounted) return;
    final publicRoot = (pub == null || pub.isEmpty)
        ? null
        : _trimOrderRoot(pub);
    final root = wifiOnly
        ? _localCustomerWebRoot()
        : (publicRoot ?? _localCustomerWebRoot());
    setState(() {
      _wifiOnlyQr = wifiOnly;
      _publicBase = pub;
      _baseUrl = '$root/order';
    });
  }

  Future<void> _reload() async {
    try {
      final list = await widget.api.tables();
      if (!mounted) return;
      setState(() {
        _tables = list;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
      setState(() => _loading = false);
    }
  }

  Future<void> _printQr(PosTable table, String url) async {
    if (_printingTableIds.contains(table.id)) return; // double-tap guard
    setState(() => _printingTableIds.add(table.id));
    try {
      await widget.api.printQrLabel(
        url: url,
        tableName: table.name,
        tableCode: table.code,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('ส่งคิวพิมพ์ QR "${table.name}" แล้ว')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('พิมพ์ไม่สำเร็จ: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _printingTableIds.remove(table.id));
    }
  }

  Future<void> _rotate(int id) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('สร้าง QR ใหม่?'),
        content: const Text('ลูกค้าที่เคยสแกน token เก่าจะใช้ไม่ได้แล้ว'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('ยกเลิก'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('สร้างใหม่'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.rotateTableQr(id);
      _reload();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _rotateAllQr() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('ยกเลิก QR เก่าทั้งหมด?'),
        content: const Text(
          'ระบบจะสร้าง token ใหม่ทุกโต๊ะ และ QR เก่าที่พิมพ์ไว้จะใช้ไม่ได้ทันที',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('ยกเลิก'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
            child: const Text('ยกเลิก QR เก่า'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _rotatingAll = true);
    try {
      final result = await widget.api.rotateAllTableQr();
      await _reload();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'ยกเลิก QR เก่าทั้งหมดแล้ว · สร้างใหม่ ${result['rotated_count'] ?? 0} จุด',
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _rotatingAll = false);
    }
  }

  Future<void> _delete(PosTable t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        content: Text(
          'ลบโต๊ะ "${t.name}"? ถ้ามีประวัติออเดอร์ ระบบจะปิดใช้งานแทนเพื่อเก็บประวัติขายไว้',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('ยกเลิก'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('ลบ / ปิดใช้งาน'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.deleteTable(t.id);
      _reload();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  void _openEditor([PosTable? t]) {
    showDialog(
      context: context,
      builder: (_) => _TableEditor(api: widget.api, initial: t),
    ).then((_) => _reload());
  }

  Widget _baseUrlBanner() {
    final usingPublic =
        !_wifiOnlyQr && _publicBase != null && !_isLanLikeUrl(_baseUrl);
    return Card(
      color: _wifiOnlyQr
          ? const Color(0xFFE8F5E9)
          : (usingPublic ? const Color(0xFFE8F5E9) : const Color(0xFFFFF5CC)),
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(
          children: [
            Icon(
              usingPublic ? Icons.public : Icons.wifi,
              color: (_wifiOnlyQr || usingPublic)
                  ? const Color(0xFF06D6A0)
                  : const Color(0xFF8A6500),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _wifiOnlyQr
                        ? '🟢 QR เฉพาะ WiFi ร้าน'
                        : (usingPublic
                              ? '🟢 QR ใช้ public URL'
                              : '⚠️ QR ยังเป็น LAN'),
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(
                    _baseUrl,
                    style: const TextStyle(fontSize: 11, color: Colors.grey),
                  ),
                  if (_wifiOnlyQr)
                    const Text(
                      'ลูกค้าต้องต่อ WiFi ร้านก่อนสแกน เพื่อป้องกันการสั่งจากที่อื่น',
                      style: TextStyle(fontSize: 10, color: Color(0xFF1F6F43)),
                    )
                  else if (!usingPublic)
                    const Text(
                      'ลูกค้าใช้เน็ตตัวเองสแกนไม่ได้ — ตั้ง PUBLIC_BASE_URL ใน backend/.env',
                      style: TextStyle(fontSize: 10, color: Color(0xFF8A6500)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _reload,
          child: ListView.builder(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 80),
            itemCount: _tables.length + 1, // +1 for the URL banner
            itemBuilder: (_, i) {
              if (i == 0) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _baseUrlBanner(),
                    Card(
                      color: const Color(0xFFFFEBEE),
                      child: Padding(
                        padding: const EdgeInsets.all(10),
                        child: OutlinedButton.icon(
                          icon: _rotatingAll
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(
                                  Icons.warning_amber,
                                  color: Colors.red,
                                ),
                          label: Text(
                            _rotatingAll
                                ? 'กำลังยกเลิก QR เก่า...'
                                : 'ยกเลิก QR เก่าทั้งหมด',
                          ),
                          onPressed: _rotatingAll ? null : _rotateAllQr,
                          style: OutlinedButton.styleFrom(
                            foregroundColor: Colors.red,
                          ),
                        ),
                      ),
                    ),
                  ],
                );
              }
              final t = _tables[i - 1];
              final tableKind = t.isTakeaway
                  ? 'จุดสั่งกลับบ้าน'
                  : '${t.seats} ที่';
              final url = '$_baseUrl?t=${t.qrToken}';
              return Card(
                child: Opacity(
                  opacity: t.isActive ? 1 : .4,
                  child: ExpansionTile(
                    leading: Icon(
                      t.isTakeaway
                          ? Icons.shopping_bag
                          : Icons.table_restaurant,
                      color: _kNavy,
                    ),
                    title: Text(
                      '${t.code} · ${t.name}',
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                    subtitle: Text(
                      '$tableKind · token: ${t.qrToken.substring(0, 8)}…',
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          children: [
                            Image.network(
                              widget.api.qrUrl(url, size: 240),
                              headers: AppConfig.tunnelHeaders,
                              height: 200,
                              errorBuilder: (_, __, ___) =>
                                  const Icon(Icons.qr_code_2, size: 100),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              url,
                              style: const TextStyle(
                                fontSize: 10,
                                color: Colors.grey,
                              ),
                            ),
                            const SizedBox(height: 12),
                            Builder(builder: (ctx) {
                              final role = context
                                  .read<AuthService>()
                                  .user
                                  ?.role;
                              final canPrint = role == 'admin' ||
                                  role == 'super_admin' ||
                                  role == 'staff';
                              final printing =
                                  _printingTableIds.contains(t.id);
                              return Wrap(
                                spacing: 4,
                                runSpacing: 4,
                                alignment: WrapAlignment.spaceEvenly,
                                children: [
                                  if (canPrint)
                                    TextButton.icon(
                                      icon: printing
                                          ? const SizedBox(
                                              width: 14,
                                              height: 14,
                                              child:
                                                  CircularProgressIndicator(
                                                strokeWidth: 2,
                                              ),
                                            )
                                          : const Icon(Icons.receipt_long),
                                      label: Text(
                                        printing
                                            ? 'กำลังส่ง…'
                                            : 'พิมพ์ QR',
                                      ),
                                      onPressed: printing
                                          ? null
                                          : () => _printQr(t, url),
                                    ),
                                  TextButton.icon(
                                    icon: const Icon(Icons.refresh),
                                    label: const Text('Rotate QR'),
                                    onPressed: () => _rotate(t.id),
                                  ),
                                  TextButton.icon(
                                    icon: const Icon(Icons.edit),
                                    label: const Text('แก้ไข'),
                                    onPressed: () => _openEditor(t),
                                  ),
                                  TextButton.icon(
                                    icon: const Icon(
                                      Icons.delete,
                                      color: Colors.red,
                                    ),
                                    label: const Text(
                                      'ลบ',
                                      style: TextStyle(color: Colors.red),
                                    ),
                                    onPressed: () => _delete(t),
                                  ),
                                ],
                              );
                            }),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        Positioned(
          bottom: 16,
          right: 16,
          child: FloatingActionButton.extended(
            backgroundColor: _kNavy,
            foregroundColor: Colors.white,
            onPressed: () => _openEditor(),
            icon: const Icon(Icons.add),
            label: const Text('เพิ่มโต๊ะ'),
          ),
        ),
      ],
    );
  }
}

class _TableEditor extends StatefulWidget {
  final ApiService api;
  final PosTable? initial;
  const _TableEditor({required this.api, this.initial});
  @override
  State<_TableEditor> createState() => _TableEditorState();
}

class _TableEditorState extends State<_TableEditor> {
  late TextEditingController _code, _name, _seats;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _code = TextEditingController(text: widget.initial?.code ?? '');
    _name = TextEditingController(text: widget.initial?.name ?? '');
    _seats = TextEditingController(text: '${widget.initial?.seats ?? 4}');
  }

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    _seats.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_code.text.trim().isEmpty || _name.text.trim().isEmpty) return;
    setState(() => _saving = true);
    try {
      final body = {
        'code': _code.text.trim(),
        'name': _name.text.trim(),
        'seats': int.tryParse(_seats.text) ?? 4,
      };
      if (widget.initial != null) {
        // PUT only allows name/seats/is_active edit (code is immutable)
        await widget.api.updateTable(widget.initial!.id, {
          'name': body['name'],
          'seats': body['seats'],
        });
      } else {
        await widget.api.createTable(body);
      }
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEdit = widget.initial != null;
    return AlertDialog(
      title: Text(isEdit ? 'แก้ไขโต๊ะ' : 'เพิ่มโต๊ะ'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _code,
            enabled: !isEdit,
            decoration: const InputDecoration(labelText: 'Code (เช่น A1)'),
          ),
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'ชื่อโต๊ะ'),
          ),
          TextField(
            controller: _seats,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'จำนวนที่นั่ง'),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('ยกเลิก'),
        ),
        ElevatedButton(
          onPressed: _saving ? null : _save,
          child: const Text('บันทึก'),
        ),
      ],
    );
  }
}

// ─── Printer (Bluetooth + Server fallback) ──────────────────────────────
class _PrinterTab extends StatefulWidget {
  final ApiService api;
  const _PrinterTab({required this.api});
  @override
  State<_PrinterTab> createState() => _PrinterTabState();
}

class _PrinterTabState extends State<_PrinterTab>
    with SingleTickerProviderStateMixin {
  late TabController _tab;
  Map<String, dynamic>? _config;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 2, vsync: this);
    _loadConfig();
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  Future<void> _loadConfig() async {
    try {
      final res = await widget.api.request('GET', '/api/print/config');
      if (mounted) setState(() => _config = res as Map<String, dynamic>);
    } catch (_) {}
  }

  Future<void> _testServer() async {
    try {
      final res =
          await widget.api.request('POST', '/api/print/test')
              as Map<String, dynamic>;
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('queued job#${res['id']}')));
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          color: Colors.grey[100],
          child: TabBar(
            controller: _tab,
            labelColor: _kNavy,
            indicatorColor: _kNavy,
            tabs: const [
              Tab(
                icon: Icon(Icons.bluetooth, size: 18),
                text: 'Bluetooth (มือถือ)',
              ),
              Tab(icon: Icon(Icons.lan, size: 18), text: 'Network (server)'),
            ],
          ),
        ),
        Expanded(
          child: TabBarView(
            controller: _tab,
            children: [
              BluetoothPrinterSettings(api: widget.api),
              _serverConfigView(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _serverConfigView() {
    if (_config == null)
      return const Center(child: CircularProgressIndicator());
    final c = _config!;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'การตั้งค่า Network Printer (Server)',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                _row('สถานะ', c['enabled'] == true ? '🟢 เปิด' : '⛔ ปิด'),
                _row('Host', '${c['host'] ?? "(ไม่ได้ตั้ง)"}'),
                _row('Port', '${c['port']}'),
                _row('Render mode', '${c['render_mode']}'),
                _row(
                  'Width',
                  '${c['width']} ตัวอักษร / ${c['width_px'] ?? "-"} px',
                ),
                const SizedBox(height: 8),
                const Text(
                  'แก้ใน backend/.env แล้ว restart service',
                  style: TextStyle(fontSize: 11, color: Colors.grey),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        ElevatedButton.icon(
          onPressed: _testServer,
          style: ElevatedButton.styleFrom(
            backgroundColor: _kNavy,
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(vertical: 14),
          ),
          icon: const Icon(Icons.print),
          label: const Text('ทดสอบพิมพ์ผ่าน server'),
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(12),
          color: const Color(0xFFE8F4FD),
          child: const Text(
            '💡 ลำดับการพิมพ์:\n'
            '• ถ้ามือถือเลือก Bluetooth printer ไว้ → จะพิมพ์ผ่าน Bluetooth ทันที\n'
            '• ถ้าไม่ได้เลือก Bluetooth → จะส่งไปที่ Network printer ของ server',
            style: TextStyle(fontSize: 12, color: Color(0xFF2980B9)),
          ),
        ),
      ],
    );
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      children: [
        SizedBox(
          width: 110,
          child: Text(
            label,
            style: const TextStyle(color: Colors.grey, fontSize: 13),
          ),
        ),
        Expanded(child: Text(value, style: const TextStyle(fontSize: 14))),
      ],
    ),
  );
}

// ─── Restaurant Settings ──────────────────────────────────────────────
class _SettingsTab extends StatefulWidget {
  final ApiService api;
  const _SettingsTab({required this.api});
  @override
  State<_SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<_SettingsTab> {
  RestaurantSettings? _s;
  late TextEditingController _name, _logo, _currency;
  late TextEditingController _paymentQrId;
  late TextEditingController _paymentQrRawPayload;
  late TextEditingController _paymentQrAccountName;
  late TextEditingController _paymentQrLabel;
  late TextEditingController _paymentQrRef1Prefix;
  late TextEditingController _paymentQrRef2;
  late TextEditingController _orderingOpenTime;
  late TextEditingController _orderingCloseTime;
  late TextEditingController _orderingTimezone;
  late TextEditingController _orderingShopLat;
  late TextEditingController _orderingShopLng;
  late TextEditingController _orderingMaxDistanceM;
  bool _paymentQrEnabled = false;
  bool _paymentQrIncludeAmount = true;
  bool _paymentAutoCloseEnabled = true;
  String _paymentQrType = 'promptpay';
  bool _orderingEnabled = true;
  bool _orderingRequireSession = true;
  bool _orderingRequireGps = false;
  bool _saving = false;
  bool _savingPayment = false;
  bool _savingOrdering = false;
  String? _err;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController();
    _logo = TextEditingController();
    _currency = TextEditingController();
    _paymentQrId = TextEditingController();
    _paymentQrRawPayload = TextEditingController();
    _paymentQrAccountName = TextEditingController();
    _paymentQrLabel = TextEditingController();
    _paymentQrRef1Prefix = TextEditingController();
    _paymentQrRef2 = TextEditingController();
    _orderingOpenTime = TextEditingController();
    _orderingCloseTime = TextEditingController();
    _orderingTimezone = TextEditingController();
    _orderingShopLat = TextEditingController();
    _orderingShopLng = TextEditingController();
    _orderingMaxDistanceM = TextEditingController(text: '20');
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _logo.dispose();
    _currency.dispose();
    _paymentQrId.dispose();
    _paymentQrRawPayload.dispose();
    _paymentQrAccountName.dispose();
    _paymentQrLabel.dispose();
    _paymentQrRef1Prefix.dispose();
    _paymentQrRef2.dispose();
    _orderingOpenTime.dispose();
    _orderingCloseTime.dispose();
    _orderingTimezone.dispose();
    _orderingShopLat.dispose();
    _orderingShopLng.dispose();
    _orderingMaxDistanceM.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final s = await widget.api.getSettings();
      if (!mounted) return;
      setState(() {
        _s = s;
        _name.text = s.name;
        _logo.text = s.logo ?? '';
        _currency.text = s.currency;
        _paymentQrEnabled = s.paymentQrEnabled;
        _paymentQrType = s.paymentQrType;
        _paymentQrId.text = s.paymentQrId ?? '';
        _paymentQrRawPayload.text = s.paymentQrRawPayload ?? '';
        _paymentQrAccountName.text = s.paymentQrAccountName ?? '';
        _paymentQrLabel.text = s.paymentQrLabel;
        _paymentQrIncludeAmount = s.paymentQrIncludeAmount;
        _paymentAutoCloseEnabled = s.paymentAutoCloseEnabled;
        _paymentQrRef1Prefix.text = s.paymentQrRef1Prefix;
        _paymentQrRef2.text = s.paymentQrRef2 ?? '';
        _orderingEnabled = s.orderingEnabled;
        _orderingOpenTime.text = s.orderingOpenTime;
        _orderingCloseTime.text = s.orderingCloseTime;
        _orderingTimezone.text = s.orderingTimezone;
        _orderingRequireSession = s.orderingRequireSession;
        _orderingRequireGps = s.orderingRequireGps;
        _orderingShopLat.text = s.orderingShopLat?.toString() ?? '';
        _orderingShopLng.text = s.orderingShopLng?.toString() ?? '';
        _orderingMaxDistanceM.text = s.orderingMaxDistanceM.toString();
      });
    } catch (e) {
      if (mounted) setState(() => _err = e.toString());
    }
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await widget.api.updateSettings(
        name: _name.text.trim(),
        logo: _logo.text.trim().isEmpty ? null : _logo.text.trim(),
        currency: _currency.text.trim().isEmpty ? '฿' : _currency.text.trim(),
      );
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('บันทึกแล้ว')));
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _savePaymentQr() async {
    setState(() => _savingPayment = true);
    try {
      final next = await widget.api.updateSettings(
        paymentQrEnabled: _paymentQrEnabled,
        paymentQrType: _paymentQrType,
        paymentQrId: _paymentQrId.text.trim(),
        paymentQrRawPayload: _paymentQrRawPayload.text.trim(),
        paymentQrAccountName: _paymentQrAccountName.text.trim(),
        paymentQrLabel: _paymentQrLabel.text.trim().isEmpty
            ? 'สแกนจ่ายเงิน'
            : _paymentQrLabel.text.trim(),
        paymentQrIncludeAmount: _paymentQrType == 'raw'
            ? false
            : _paymentQrIncludeAmount,
        paymentQrRef1Prefix: _paymentQrRef1Prefix.text.trim().isEmpty
            ? 'ORDER'
            : _paymentQrRef1Prefix.text.trim(),
        paymentQrRef2: _paymentQrRef2.text.trim(),
        paymentAutoCloseEnabled: _paymentAutoCloseEnabled,
      );
      if (!mounted) return;
      setState(() => _s = next);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('บันทึก QR ชำระเงินแล้ว')));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _savingPayment = false);
    }
  }

  Future<void> _saveOrdering() async {
    final openTime = _orderingOpenTime.text.trim();
    final closeTime = _orderingCloseTime.text.trim();
    final timePattern = RegExp(r'^\d{2}:\d{2}$');
    if (!timePattern.hasMatch(openTime) || !timePattern.hasMatch(closeTime)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('เวลาเปิด/ปิดต้องเป็นรูปแบบ HH:mm')),
      );
      return;
    }
    final shopLat = double.tryParse(_orderingShopLat.text.trim());
    final shopLng = double.tryParse(_orderingShopLng.text.trim());
    final maxDistance =
        int.tryParse(
          _orderingMaxDistanceM.text.trim().isEmpty
              ? '20'
              : _orderingMaxDistanceM.text.trim(),
        ) ??
        20;
    if (_orderingRequireGps &&
        (shopLat == null ||
            shopLng == null ||
            shopLat.abs() > 90 ||
            shopLng.abs() > 180)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('ต้องตั้งพิกัดร้านให้ถูกต้องก่อนเปิด GPS guard'),
        ),
      );
      return;
    }
    if (maxDistance < 1 || maxDistance > 10000) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('รัศมี GPS ต้องอยู่ระหว่าง 1-10000 เมตร')),
      );
      return;
    }
    setState(() => _savingOrdering = true);
    try {
      final next = await widget.api.updateSettings(
        orderingEnabled: _orderingEnabled,
        orderingOpenTime: openTime,
        orderingCloseTime: closeTime,
        orderingTimezone: _orderingTimezone.text.trim().isEmpty
            ? 'Asia/Bangkok'
            : _orderingTimezone.text.trim(),
        orderingRequireSession: _orderingRequireSession,
        orderingRequirePrivateIp: false,
        orderingRequireGps: _orderingRequireGps,
        orderingShopLat: shopLat,
        orderingShopLng: shopLng,
        orderingMaxDistanceM: maxDistance,
      );
      if (!mounted) return;
      setState(() => _s = next);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('บันทึกเวลารับออเดอร์แล้ว')));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
      }
    } finally {
      if (mounted) setState(() => _savingOrdering = false);
    }
  }

  Future<void> _pickOrderingTime(TextEditingController controller) async {
    final parts = controller.text.split(':');
    final initial = TimeOfDay(
      hour: parts.isNotEmpty ? int.tryParse(parts[0]) ?? 0 : 0,
      minute: parts.length > 1 ? int.tryParse(parts[1]) ?? 0 : 0,
    );
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked == null) return;
    controller.text =
        '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    if (_err != null)
      return Center(
        child: Text(_err!, style: const TextStyle(color: Colors.red)),
      );
    if (_s == null) return const Center(child: CircularProgressIndicator());
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                const Text(
                  '🍽️ ข้อมูลร้าน',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _name,
                  decoration: const InputDecoration(
                    labelText: 'ชื่อร้าน',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _logo,
                  maxLength: 4,
                  decoration: const InputDecoration(
                    labelText: 'Logo (emoji เช่น 🍜)',
                    border: OutlineInputBorder(),
                  ),
                ),
                TextField(
                  controller: _currency,
                  maxLength: 4,
                  decoration: const InputDecoration(
                    labelText: 'สกุลเงิน',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _kNavy,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: _saving ? null : _save,
                    child: _saving
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('💾 บันทึก'),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'เวลารับออเดอร์และป้องกันสั่งนอกร้าน',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 6),
                const Text(
                  'ใช้กันลูกค้าสั่งนอกเวลา และป้องกันการสั่งจากนอกร้านด้วย WiFi/GPS',
                  style: TextStyle(fontSize: 12, color: Colors.grey),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('เปิดรับออเดอร์จาก QR ลูกค้า'),
                  value: _orderingEnabled,
                  onChanged: (v) => setState(() => _orderingEnabled = v),
                ),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _orderingOpenTime,
                        keyboardType: TextInputType.datetime,
                        decoration: InputDecoration(
                          labelText: 'เปิดรับ',
                          hintText: '09:00',
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            icon: const Icon(Icons.schedule),
                            onPressed: () =>
                                _pickOrderingTime(_orderingOpenTime),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: _orderingCloseTime,
                        keyboardType: TextInputType.datetime,
                        decoration: InputDecoration(
                          labelText: 'ปิดรับ',
                          hintText: '21:00',
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            icon: const Icon(Icons.schedule),
                            onPressed: () =>
                                _pickOrderingTime(_orderingCloseTime),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _orderingTimezone,
                  decoration: const InputDecoration(
                    labelText: 'Timezone',
                    hintText: 'Asia/Bangkok',
                    border: OutlineInputBorder(),
                  ),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('ผูก session ลูกค้ากับเครื่องที่สแกน QR'),
                  value: _orderingRequireSession,
                  onChanged: (v) =>
                      setState(() => _orderingRequireSession = v ?? true),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('ป้องกันการสั่งนอกร้าน'),
                  subtitle: const Text(
                    'อยู่บน WiFi ร้านผ่านทันที; นอก WiFi ต้องใช้ GPS และอยู่ในรัศมีนี้',
                  ),
                  value: _orderingRequireGps,
                  onChanged: (v) =>
                      setState(() => _orderingRequireGps = v ?? false),
                ),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _orderingShopLat,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                          signed: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'ละติจูดร้าน',
                          hintText: '13.756331',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: _orderingShopLng,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                          signed: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'ลองจิจูดร้าน',
                          hintText: '100.501765',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _orderingMaxDistanceM,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'รัศมีสูงสุด (เมตร)',
                    hintText: '20',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: 48,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _kNavy,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: _savingOrdering ? null : _saveOrdering,
                    icon: _savingOrdering
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.access_time),
                    label: Text(
                      _savingOrdering
                          ? 'กำลังบันทึก...'
                          : 'บันทึกเวลารับออเดอร์',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'QR ชำระเงินบนใบเสร็จ',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 6),
                const Text(
                  'ใช้ได้เฉพาะบัญชี admin และจะถูกใช้กับใบเสร็จจากทั้ง mobile BLE และ server printer',
                  style: TextStyle(fontSize: 12, color: Colors.grey),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('แสดง QR จ่ายเงินในใบเสร็จลูกค้า'),
                  value: _paymentQrEnabled,
                  onChanged: (v) => setState(() => _paymentQrEnabled = v),
                ),
                DropdownButtonFormField<String>(
                  value: _paymentQrType,
                  decoration: const InputDecoration(
                    labelText: 'ประเภท QR',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'promptpay',
                      child: Text('พร้อมเพย์'),
                    ),
                    DropdownMenuItem(
                      value: 'merchant',
                      child: Text('รหัสร้าน Thai QR'),
                    ),
                    DropdownMenuItem(
                      value: 'raw',
                      child: Text('Raw QR payload'),
                    ),
                  ],
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() {
                      _paymentQrType = v;
                      if (v == 'raw') _paymentQrIncludeAmount = false;
                    });
                  },
                ),
                const SizedBox(height: 10),
                if (_paymentQrType != 'raw') ...[
                  TextField(
                    controller: _paymentQrId,
                    keyboardType: TextInputType.number,
                    decoration: InputDecoration(
                      labelText: _paymentQrType == 'merchant'
                          ? 'รหัสร้าน / Biller ID'
                          : 'เลขพร้อมเพย์',
                      hintText: _paymentQrType == 'merchant'
                          ? '014000009395435'
                          : 'เบอร์มือถือ / เลขบัตร / e-Wallet ID',
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                ] else ...[
                  TextField(
                    controller: _paymentQrRawPayload,
                    minLines: 3,
                    maxLines: 6,
                    decoration: const InputDecoration(
                      labelText: 'Raw QR payload',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                ],
                TextField(
                  controller: _paymentQrAccountName,
                  decoration: const InputDecoration(
                    labelText: 'ชื่อบัญชี / ชื่อร้าน',
                    hintText: 'ชื่อบัญชีที่แสดงใต้ QR',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _paymentQrLabel,
                  decoration: const InputDecoration(
                    labelText: 'หัวข้อบนใบเสร็จ',
                    border: OutlineInputBorder(),
                  ),
                ),
                if (_paymentQrType == 'merchant') ...[
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _paymentQrRef1Prefix,
                          decoration: const InputDecoration(
                            labelText: 'Ref1 prefix',
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _paymentQrRef2,
                          decoration: const InputDecoration(
                            labelText: 'Ref2',
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('ใส่ยอดรวมของออเดอร์ใน QR'),
                  value: _paymentQrIncludeAmount,
                  onChanged: _paymentQrType == 'raw'
                      ? null
                      : (v) =>
                            setState(() => _paymentQrIncludeAmount = v ?? true),
                ),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text(
                    'ปิดงานอัตโนมัติเมื่อ payment webhook ยืนยันว่าเงินเข้าแล้ว',
                  ),
                  subtitle: const Text(
                    'การสแกน QR อย่างเดียวไม่ปิดงาน ต้องมี gateway/bank webhook หรือยืนยันด้วย staff',
                  ),
                  value: _paymentAutoCloseEnabled,
                  onChanged: (v) =>
                      setState(() => _paymentAutoCloseEnabled = v ?? true),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: 48,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _kNavy,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: _savingPayment ? null : _savePaymentQr,
                    icon: _savingPayment
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.qr_code_2),
                    label: Text(
                      _savingPayment ? 'กำลังบันทึก...' : 'บันทึก QR ชำระเงิน',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _BarcodePrintDialog extends StatefulWidget {
  final ApiService api;
  final Product product;
  const _BarcodePrintDialog({required this.api, required this.product});

  @override
  State<_BarcodePrintDialog> createState() => _BarcodePrintDialogState();
}

class _BarcodePrintDialogState extends State<_BarcodePrintDialog> {
  List<Map<String, dynamic>> _stations = [];
  String? _stationKey;
  int _copies = 1;
  bool _loading = true;
  bool _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadStations();
  }

  Future<void> _loadStations() async {
    try {
      final list = await widget.api.printStations();
      if (!mounted) return;
      final active = list
          .where((s) => s['is_active'] == null || s['is_active'] == true)
          .toList();
      setState(() {
        _stations = active;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _send() async {
    if (_sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await widget.api.printBarcodeLabel(
        widget.product.id,
        stationKey: _stationKey,
        copies: _copies,
      );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _sending = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('🖨 พิมพ์ barcode · ${widget.product.name}'),
      content: SizedBox(
        width: 320,
        child: _loading
            ? const Padding(
                padding: EdgeInsets.all(20),
                child: Center(child: CircularProgressIndicator()),
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Barcode: ${widget.product.barcode ?? '-'}',
                    style: const TextStyle(color: Colors.grey),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'เครื่องพิมพ์',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                  ),
                  const SizedBox(height: 4),
                  DropdownButtonFormField<String?>(
                    initialValue: _stationKey,
                    decoration: const InputDecoration(
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      const DropdownMenuItem<String?>(
                        value: null,
                        child: Text('(ค่าเริ่มต้นในระบบ)'),
                      ),
                      ..._stations.map((s) => DropdownMenuItem<String?>(
                            value: s['key'] as String?,
                            child: Text(
                              '${s['name']} (${s['printer_key'] ?? s['printer_host'] ?? s['key']})',
                              overflow: TextOverflow.ellipsis,
                            ),
                          )),
                    ],
                    onChanged: _sending
                        ? null
                        : (v) => setState(() => _stationKey = v),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'จำนวน (1-8)',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12),
                  ),
                  const SizedBox(height: 4),
                  DropdownButtonFormField<int>(
                    initialValue: _copies,
                    decoration: const InputDecoration(
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    items: const [1, 2, 3, 4, 5, 6, 8]
                        .map((n) =>
                            DropdownMenuItem<int>(value: n, child: Text('$n')))
                        .toList(),
                    onChanged: _sending
                        ? null
                        : (v) => setState(() => _copies = v ?? 1),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 8),
                    Text(_error!,
                        style: const TextStyle(color: Colors.red, fontSize: 12)),
                  ],
                ],
              ),
      ),
      actions: [
        TextButton(
          onPressed: _sending ? null : () => Navigator.pop(context, false),
          child: const Text('ยกเลิก'),
        ),
        ElevatedButton.icon(
          onPressed: (_loading || _sending) ? null : _send,
          icon: _sending
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : const Icon(Icons.receipt_long),
          label: Text(_sending ? 'กำลังส่ง...' : '🧾 ส่งคิวพิมพ์'),
          style: ElevatedButton.styleFrom(
            backgroundColor: _kNavy,
            foregroundColor: Colors.white,
          ),
        ),
      ],
    );
  }
}

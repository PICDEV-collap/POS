import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../models/order.dart';
import '../models/product.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/socket_service.dart';
import '../services/print_helper.dart';
import '../services/bluetooth_printer_service.dart';
import 'admin_login_screen.dart';
import 'barcode_scanner_screen.dart';
import 'bluetooth_printer_settings.dart';

const _kNavy = Color(0xFF1A1A2E);
const _kOrange = Color(0xFFE85D04);

const _statusLabel = {
  'pending': 'รอ',
  'cooking': 'กำลังทำ',
  'served': 'เสิร์ฟแล้ว',
  'paid': 'ชำระแล้ว',
  'cancelled': 'ยกเลิก',
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

class StaffScreen extends StatefulWidget {
  const StaffScreen({super.key});

  @override
  State<StaffScreen> createState() => _StaffScreenState();
}

class _StaffScreenState extends State<StaffScreen> with WidgetsBindingObserver {
  late ApiService _api;

  // Catalog
  List<Category> _categories = [];
  List<Product> _products = [];
  List<PosTable> _tables = [];

  // Workflow state
  PosTable? _selectedTable;
  int? _activeCat;
  // Keyed by `_CartItem.key` (product+variant+options) so different choice
  // combinations of the same dish stay as separate cart lines.
  final Map<String, _CartItem> _cart = {};
  String _orderNote = '';

  // Open orders per table for "ของโต๊ะนี้" panel
  List<PosOrder> _orders = [];

  bool _loading = true;
  String? _err;
  bool _reloadOrdersInFlight = false;
  bool _reloadOrdersAgain = false;
  String _scanCode = '';
  bool _scanBusy = false;
  final TextEditingController _scanController = TextEditingController();
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _api = ApiService(context.read<AuthService>());
    context.read<SocketService>().connect();
    _bootstrap();
    _startFallbackPolling();
    final s = context.read<SocketService>();
    s.on('order:new', _onEvt);
    s.on('order:update', _onEvt);
  }

  @override
  void dispose() {
    final s = context.read<SocketService>();
    s.off('order:new', _onEvt);
    s.off('order:update', _onEvt);
    _pollTimer?.cancel();
    _scanController.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _onEvt(_) => unawaited(_reloadOrders());

  void _startFallbackPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted) return;
      if (!context.read<SocketService>().connected) {
        unawaited(_reloadOrders());
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || !mounted) return;
    context.read<SocketService>().resume();
    unawaited(_reloadOrders());
  }

  Future<void> _bootstrap() async {
    try {
      final menuFut = _api.publicMenu();
      final tablesFut = _api.tables();
      final ordersFut = _api.listOrders();
      final results = await Future.wait([menuFut, tablesFut, ordersFut]);
      final menu = results[0] as Map<String, dynamic>;
      final tables = results[1] as List<PosTable>;
      final orders = results[2] as List<PosOrder>;
      if (!mounted) return;
      setState(() {
        _categories = (menu['categories'] as List)
            .map((j) => Category.fromJson(j as Map<String, dynamic>))
            .toList();
        _products = (menu['products'] as List)
            .map((j) => Product.fromJson(j as Map<String, dynamic>))
            .toList();
        _tables = tables.where((t) => t.isActive).toList();
        _orders = orders;
        _loading = false;
        _activeCat = _categories.isNotEmpty ? _categories.first.id : null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _err = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _reloadOrders() async {
    if (_reloadOrdersInFlight) {
      _reloadOrdersAgain = true;
      return;
    }
    _reloadOrdersInFlight = true;
    try {
      final list = await _api.listOrders();
      if (!mounted) return;
      setState(() {
        _orders = list;
        _err = null;
      });
    } catch (e) {
      if (mounted) setState(() => _err = e.toString());
    } finally {
      _reloadOrdersInFlight = false;
      if (_reloadOrdersAgain && mounted) {
        _reloadOrdersAgain = false;
        unawaited(_reloadOrders());
      }
    }
  }

  Future<void> _openWebStaff() async {
    final url = Uri.parse(
      '${AppConfig.apiBase.replaceAll(':4000', ':3000')}/staff',
    );
    if (await canLaunchUrl(url))
      await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  Future<void> _openAdminLogin() async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => const AdminLoginScreen()));
  }

  Future<void> _addToCart(Product p) async {
    final hasVariants = (p.variants?.isNotEmpty ?? false);
    final hasOptions = (p.options?.isNotEmpty ?? false);
    String? variantName;
    List<OrderItemOption> optionsSelected = const [];
    if (hasVariants || hasOptions) {
      final picked = await _pickVariantAndOptions(p);
      if (picked == null) return; // user cancelled
      variantName = picked.$1;
      optionsSelected = picked.$2;
    }
    final newItem = _CartItem(
      product: p,
      qty: 1,
      note: '',
      variantName: variantName,
      optionsSelected: optionsSelected,
    );
    setState(() {
      final cur = _cart[newItem.key];
      _cart[newItem.key] = cur == null
          ? newItem
          : cur.copyWith(qty: cur.qty + 1);
    });
  }

  Future<void> _addScannedProduct() async {
    final code = _scanCode.trim();
    if (code.isEmpty || _scanBusy) return;
    setState(() {
      _scanBusy = true;
      _err = null;
    });
    try {
      Product product;
      final cached = _products.where((p) => (p.barcode ?? '') == code);
      product = cached.isNotEmpty
          ? cached.first
          : await _api.productByBarcode(code);
      if ((product.trackStock || product.productType == 'stock') &&
          product.stockQty <= 0) {
        throw Exception('สินค้า "${product.name}" หมดสต๊อก');
      }
      if (!mounted) return;
      _scanController.clear();
      setState(() => _scanCode = '');
      await _addToCart(product);
    } catch (e) {
      if (mounted) setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _scanBusy = false);
    }
  }

  Future<void> _openBarcodeScanner() async {
    if (_scanBusy) return;
    final status = await Permission.camera.request();
    if (!mounted) return;
    if (!status.isGranted) {
      setState(() {
        _err = status.isPermanentlyDenied
            ? 'ไม่ได้รับอนุญาตใช้กล้อง กรุณาเปิด permission กล้องใน Settings ของแอป'
            : 'ต้องอนุญาตกล้องก่อนสแกนบาร์โค้ด';
      });
      if (status.isPermanentlyDenied) {
        unawaited(openAppSettings());
      }
      return;
    }
    final code = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const BarcodeScannerScreen()),
    );
    if (!mounted || code == null || code.trim().isEmpty) return;
    _scanController.text = code.trim();
    setState(() => _scanCode = code.trim());
    await _addScannedProduct();
  }

  void _setQty(String key, int qty) {
    setState(() {
      if (qty <= 0) {
        _cart.remove(key);
      } else {
        _cart[key] = _cart[key]!.copyWith(qty: qty);
      }
    });
  }

  Future<(String?, List<OrderItemOption>)?> _pickVariantAndOptions(
    Product p,
  ) async {
    final rawVariants = p.variants ?? const [];
    final groups =
        (p.options ?? const [])
            .where(
              (g) => g.isAvailable && g.items.any((item) => item.isAvailable),
            )
            .toList()
          ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder));
    // Always offer the base price as "ธรรมดา" alongside any defined variants.
    // Selecting ธรรมดา returns variantName=null so order_items.variant_name
    // stays NULL (existing display logic hides empty variant suffixes).
    final variantOptions = rawVariants.isEmpty
        ? <_VariantOption>[]
        : [
            _VariantOption(
              id: '__base__',
              label: 'ธรรมดา',
              price: p.price,
              variantName: null,
            ),
            ...rawVariants.map(
              (v) => _VariantOption(
                id: v.name,
                label: v.name,
                price: v.price,
                variantName: v.name,
              ),
            ),
          ];
    String? selectedId = variantOptions.isNotEmpty
        ? variantOptions.first.id
        : null;
    final picks = <String, List<String>>{};
    for (final g in groups) {
      final defaults = g.items
          .where((item) => item.isDefault && item.isAvailable)
          .map((item) => item.name)
          .toList();
      if (defaults.isNotEmpty) {
        picks[g.name] = g.type == 'single'
            ? defaults.take(1).toList()
            : defaults.take(g.maxSelect).toList();
      }
    }
    return showDialog<(String?, List<OrderItemOption>)>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setS) {
          final selectedVariant = selectedId == null
              ? null
              : variantOptions
                    .where((v) => v.id == selectedId)
                    .cast<_VariantOption?>()
                    .firstOrNull;
          bool isVisible(OptionGroup group) {
            final condition = group.visibleWhen;
            if (condition == null || condition['group'] == null) return true;
            final selected =
                picks[condition['group'].toString()] ?? const <String>[];
            final expected =
                (condition['values'] as List?)
                    ?.map((e) => e.toString())
                    .toList() ??
                (condition['value'] == null
                    ? const <String>[]
                    : [condition['value'].toString()]);
            return selected.any(expected.contains);
          }

          final visibleGroups = groups.where(isVisible).toList();
          List<OptionItem> selectedItems(OptionGroup group) {
            final values = picks[group.name] ?? const <String>[];
            return group.items
                .where((item) => values.contains(item.name))
                .toList();
          }

          final optionSelections = visibleGroups
              .expand(
                (g) => selectedItems(g).map(
                  (item) => OrderItemOption(
                    group: g.name,
                    value: item.name,
                    priceDelta: item.priceDelta,
                  ),
                ),
              )
              .toList();
          final optionDelta = optionSelections.fold<double>(
            0,
            (sum, option) => sum + option.priceDelta,
          );
          final displayPrice =
              (selectedVariant?.price ?? p.price) + optionDelta;
          final allPicked = visibleGroups.every((g) {
            final count = selectedItems(g).length;
            return count >= g.minSelect && count <= g.maxSelect;
          });
          final canConfirm =
              (variantOptions.isEmpty || selectedVariant != null) && allPicked;
          void togglePick(OptionGroup group, OptionItem item) {
            final current = List<String>.from(
              picks[group.name] ?? const <String>[],
            );
            if (group.type == 'single') {
              picks[group.name] = [item.name];
              return;
            }
            if (current.contains(item.name)) {
              current.remove(item.name);
            } else if (current.length < group.maxSelect) {
              current.add(item.name);
            }
            picks[group.name] = current;
          }

          return AlertDialog(
            title: Text('${p.emoji ?? ""} ${p.name}'),
            content: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (variantOptions.isNotEmpty) ...[
                    const Text(
                      'ขนาด',
                      style: TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: variantOptions.map((v) {
                        final active = selectedId == v.id;
                        return ChoiceChip(
                          label: Text(
                            '${v.label} ฿${v.price.toStringAsFixed(0)}',
                          ),
                          selected: active,
                          onSelected: (_) => setS(() => selectedId = v.id),
                        );
                      }).toList(),
                    ),
                    const SizedBox(height: 10),
                  ],
                  for (final g in visibleGroups) ...[
                    Text(
                      '${g.name}${g.required ? " *" : ""}${g.type == "multiple" ? " (${g.minSelect}-${g.maxSelect})" : ""}',
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: g.items.where((item) => item.isAvailable).map((
                        item,
                      ) {
                        final selected = picks[g.name] ?? const <String>[];
                        final active = selected.contains(item.name);
                        final atMax =
                            g.type == 'multiple' &&
                            !active &&
                            selected.length >= g.maxSelect;
                        return ChoiceChip(
                          label: Text(
                            item.priceDelta == 0
                                ? item.name
                                : '${item.name} ${item.priceDelta > 0 ? "+" : ""}฿${item.priceDelta.toStringAsFixed(0)}',
                          ),
                          selected: active,
                          onSelected: atMax
                              ? null
                              : (_) => setS(() => togglePick(g, item)),
                        );
                      }).toList(),
                    ),
                    const SizedBox(height: 10),
                  ],
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, null),
                child: const Text('ยกเลิก'),
              ),
              ElevatedButton(
                onPressed: canConfirm
                    ? () {
                        Navigator.pop(ctx, (
                          selectedVariant?.variantName,
                          optionSelections,
                        ));
                      }
                    : null,
                child: Text(
                  canConfirm
                      ? 'เพิ่ม ฿${displayPrice.toStringAsFixed(0)}'
                      : 'เลือกให้ครบ',
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _placeOrder() async {
    if (_selectedTable == null || _cart.isEmpty) return;
    try {
      final isTakeawayPoint = _selectedTable!.isTakeaway;
      final items = _cart.values
          .map(
            (c) => {
              'product_id': c.product.id,
              'quantity': c.qty,
              'fulfillment_type': isTakeawayPoint ? 'takeaway' : 'dine-in',
              if (c.note.isNotEmpty) 'note': c.note,
              if (c.variantName != null) 'variant_name': c.variantName,
              if (c.optionsSelected.isNotEmpty)
                'options_selected': c.optionsSelected
                    .map((o) => o.toJson())
                    .toList(),
            },
          )
          .toList();
      final order = await _api.placeStaffOrder(
        tableId: _selectedTable!.id,
        items: items,
        note: _orderNote.isEmpty ? null : _orderNote,
        orderType: isTakeawayPoint ? 'takeaway' : 'dine-in',
      );
      if (!mounted) return;
      setState(() {
        _cart.clear();
        _orderNote = '';
      });
      unawaited(_reloadOrders());
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'สั่งสำเร็จ ลำดับ ${order.dailySeq} (#${order.id}) (${_selectedTable!.name})',
          ),
          backgroundColor: const Color(0xFF06D6A0),
        ),
      );
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _markPaid(int orderId) async {
    try {
      await _api.updateOrderStatus(orderId, 'paid');
      unawaited(_reloadOrders());
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _printReceipt(int orderId) async {
    final msg = await printOrder(
      context: context,
      api: _api,
      orderId: orderId,
      type: 'receipt',
    );
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Show a fullscreen QR for the selected table. If QR ordering is WiFi-only,
  /// generate a LAN URL so old public/ngrok QR links cannot be used off-site.
  Future<void> _showCustomerQr(PosTable table) async {
    var wifiOnly = false;
    String? pub;
    try {
      final settings = await _api.getSettings();
      wifiOnly = settings.orderingRequirePrivateIp;
    } catch (_) {
      /* keep safe LAN fallback */
    }
    try {
      final info = await _api.getDiscoveryInfo();
      pub = info['public_base_url'] as String?;
    } catch (_) {
      /* offline or backend down */
    }
    final publicRoot = (pub == null || pub.isEmpty)
        ? null
        : _trimOrderRoot(pub);
    final base = wifiOnly
        ? _localCustomerWebRoot()
        : (publicRoot ?? _localCustomerWebRoot());
    final url = '$base/order?t=${table.qrToken}';
    final isLan = _isLanLikeUrl(base);
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (_) => Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                table.isTakeaway
                    ? '📱 QR สั่งกลับบ้าน'
                    : '📱 ให้ลูกค้าสแกนเพื่อสั่งอาหาร',
                style: const TextStyle(fontSize: 13, color: Colors.grey),
              ),
              const SizedBox(height: 4),
              Text(
                table.name,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 14),
              Image.network(
                _api.qrUrl(url, size: 480),
                width: 280,
                height: 280,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) =>
                    const Icon(Icons.qr_code_2, size: 200),
              ),
              const SizedBox(height: 10),
              SelectableText(
                url,
                style: const TextStyle(fontSize: 11, color: Colors.grey),
                textAlign: TextAlign.center,
              ),
              if (wifiOnly && isLan) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFE8F5E9),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Text(
                    'โหมด WiFi ร้าน: ลูกค้าต้องต่อ WiFi ร้านก่อนสแกน QR นี้',
                    style: TextStyle(fontSize: 11, color: Color(0xFF1F6F43)),
                  ),
                ),
              ] else if (isLan) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF5CC),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Text(
                    '⚠️ URL นี้เป็น LAN — ลูกค้าใช้เน็ตตัวเองสแกนไม่ได้\n'
                    'ตั้ง PUBLIC_BASE_URL ใน backend/.env (Caddy domain หรือ ngrok URL)',
                    style: TextStyle(fontSize: 11, color: Color(0xFF8A6500)),
                  ),
                ),
              ],
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton.icon(
                    icon: const Icon(Icons.open_in_new),
                    label: const Text('เปิดใน browser'),
                    onPressed: () async {
                      await launchUrl(
                        Uri.parse(url),
                        mode: LaunchMode.externalApplication,
                      );
                    },
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _kNavy,
                      foregroundColor: Colors.white,
                    ),
                    onPressed: () => Navigator.pop(context),
                    child: const Text('ปิด'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    if (_loading) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Staff'),
          backgroundColor: _kNavy,
          foregroundColor: Colors.white,
        ),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    if (_err != null) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Staff'),
          backgroundColor: _kNavy,
          foregroundColor: Colors.white,
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Text(_err!, style: const TextStyle(color: Colors.red)),
          ),
        ),
      );
    }

    final selectedTableOrders = _selectedTable == null
        ? <PosOrder>[]
        : _orders
              .where(
                (o) =>
                    o.tableId == _selectedTable!.id &&
                    o.status != 'paid' &&
                    o.status != 'cancelled',
              )
              .toList();
    final categoryProducts = _activeCat == null
        ? <Product>[]
        : _products
              .where((p) => p.categoryId == _activeCat && p.isAvailable)
              .toList();
    final cartTotal = _cart.values.fold<double>(
      0,
      (s, c) => s + c.unitPrice * c.qty,
    );
    final cartCount = _cart.values.fold<int>(0, (s, c) => s + c.qty);

    return Scaffold(
      appBar: AppBar(
        title: Text(
          'Staff · ${auth.user?.fullName ?? auth.user?.username ?? ""}',
        ),
        backgroundColor: _kNavy,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            tooltip: 'ตั้งค่าเครื่องพิมพ์',
            icon: Icon(
              Icons.print,
              color: context.watch<BluetoothPrinterService>().hasPrinter
                  ? const Color(0xFF06D6A0)
                  : Colors.white70,
            ),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) =>
                    BluetoothPrinterSettings(api: _api, wrapInScaffold: true),
              ),
            ),
          ),
          IconButton(
            tooltip: 'admin / kitchen login',
            onPressed: _openAdminLogin,
            icon: const Icon(Icons.admin_panel_settings),
          ),
          IconButton(
            tooltip: 'web staff',
            onPressed: _openWebStaff,
            icon: const Icon(Icons.open_in_browser),
          ),
        ],
      ),
      body: _selectedTable == null
          ? _buildTableList()
          : _buildOrderingView(selectedTableOrders, categoryProducts),
      bottomSheet: (_selectedTable != null && _cart.isNotEmpty)
          ? _buildCartBar(cartCount, cartTotal)
          : null,
    );
  }

  Widget _buildTableList() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '🪑 เลือกโต๊ะเพื่อรับออเดอร์',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.bold,
              color: Colors.grey,
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: GridView.count(
              crossAxisCount: 3,
              crossAxisSpacing: 8,
              mainAxisSpacing: 8,
              childAspectRatio: 1.2,
              children: _tables.map((t) {
                final tOrders = _orders
                    .where(
                      (o) =>
                          o.tableId == t.id &&
                          o.status != 'paid' &&
                          o.status != 'cancelled',
                    )
                    .toList();
                final sum = tOrders.fold<double>(
                  0,
                  (s, o) => s + o.totalAmount,
                );
                final emptyLabel = t.isTakeaway
                    ? 'พร้อมรับออเดอร์กลับบ้าน'
                    : 'ว่าง';
                return InkWell(
                  onTap: () => setState(() => _selectedTable = t),
                  child: Card(
                    color: tOrders.isNotEmpty ? const Color(0xFFFFF8E1) : null,
                    child: Padding(
                      padding: const EdgeInsets.all(8),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            t.isTakeaway
                                ? Icons.shopping_bag
                                : Icons.table_restaurant,
                            size: 20,
                            color: tOrders.isEmpty ? Colors.grey : _kOrange,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            t.name,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            tOrders.isEmpty
                                ? emptyLabel
                                : '${tOrders.length} รอบ · ฿${sum.toStringAsFixed(0)}',
                            style: TextStyle(
                              fontSize: 12,
                              color: tOrders.isEmpty ? Colors.grey : _kOrange,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildOrderingView(
    List<PosOrder> tableOrders,
    List<Product> products,
  ) {
    return Column(
      children: [
        // Selected table bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          color: _kNavy,
          child: Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back, color: Colors.white),
                onPressed: () => setState(() {
                  _selectedTable = null;
                  _cart.clear();
                }),
              ),
              Expanded(
                child: Text(
                  _selectedTable!.name,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.bold,
                    fontSize: 16,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.qr_code_2, color: Colors.white),
                tooltip: 'แสดง QR ให้ลูกค้าสแกน',
                onPressed: () => _showCustomerQr(_selectedTable!),
              ),
            ],
          ),
        ),
        // Existing orders for this table
        if (tableOrders.isNotEmpty)
          Container(
            color: Colors.grey[100],
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '📋 ออเดอร์ของโต๊ะนี้',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.grey,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                ...tableOrders.map(
                  (o) => Card(
                    margin: const EdgeInsets.symmetric(vertical: 4),
                    child: ListTile(
                      dense: true,
                      title: Text(
                        '#${o.id} · ${_statusLabel[o.status]} · ฿${o.totalAmount.toStringAsFixed(0)}',
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(
                            icon: const Icon(Icons.print, size: 18),
                            onPressed: () => _printReceipt(o.id),
                            tooltip: 'พิมพ์ใบเสร็จ',
                          ),
                          if (o.status != 'paid')
                            ElevatedButton(
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF06D6A0),
                                foregroundColor: Colors.white,
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 10,
                                  vertical: 4,
                                ),
                              ),
                              onPressed: () => _markPaid(o.id),
                              child: const Text(
                                '💰 ชำระ',
                                style: TextStyle(fontSize: 11),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        // Category tabs
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  decoration: const InputDecoration(
                    isDense: true,
                    prefixIcon: Icon(Icons.qr_code_scanner),
                    labelText: 'สแกนบาร์โค้ด / รหัสสินค้า',
                    border: OutlineInputBorder(),
                  ),
                  textInputAction: TextInputAction.done,
                  controller: _scanController,
                  onChanged: (v) => setState(() => _scanCode = v),
                  onSubmitted: (_) => _addScannedProduct(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                tooltip: 'เปิดกล้องสแกน',
                onPressed: _scanBusy ? null : _openBarcodeScanner,
                style: IconButton.styleFrom(
                  backgroundColor: _kOrange,
                  foregroundColor: Colors.white,
                ),
                icon: const Icon(Icons.camera_alt),
              ),
              const SizedBox(width: 8),
              ElevatedButton(
                onPressed: _scanBusy || _scanCode.trim().isEmpty
                    ? null
                    : _addScannedProduct,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _kNavy,
                  foregroundColor: Colors.white,
                ),
                child: _scanBusy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('เพิ่ม'),
              ),
            ],
          ),
        ),
        // Category tabs
        SizedBox(
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            children: _categories.map((c) {
              final active = _activeCat == c.id;
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: ChoiceChip(
                  label: Text(c.name),
                  selected: active,
                  onSelected: (_) => setState(() => _activeCat = c.id),
                ),
              );
            }).toList(),
          ),
        ),
        // Product grid
        Expanded(
          child: products.isEmpty
              ? const Center(child: Text('ไม่มีเมนูในหมวดนี้'))
              : GridView.builder(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 100),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                    childAspectRatio: 1.0,
                  ),
                  itemCount: products.length,
                  itemBuilder: (_, i) {
                    final p = products[i];
                    // Sum across all variant/option combos of this product.
                    final qty = _cart.values
                        .where((c) => c.product.id == p.id)
                        .fold<int>(0, (s, c) => s + c.qty);
                    // "Simple" = no variants AND no option groups → can use the
                    // inline ± stepper, single cart line. Otherwise the user
                    // must use the picker dialog (each combo = own cart line).
                    final simple =
                        (p.variants?.isEmpty ?? true) &&
                        (p.options?.isEmpty ?? true);
                    final simpleKey = simple ? '${p.id}::::' : null;
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (p.imageUrl != null && p.imageUrl!.isNotEmpty)
                              SizedBox(
                                height: 60,
                                child: Image.network(
                                  _api.imageUrl(p.imageUrl),
                                  fit: BoxFit.cover,
                                  errorBuilder: (_, __, ___) => Container(
                                    color: Colors.grey[100],
                                    child: const Icon(
                                      Icons.fastfood,
                                      color: Colors.grey,
                                    ),
                                  ),
                                ),
                              ),
                            const SizedBox(height: 4),
                            Text(
                              p.name,
                              style: const TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (p.description != null &&
                                p.description!.isNotEmpty)
                              Text(
                                p.description!,
                                style: const TextStyle(
                                  fontSize: 10,
                                  color: Colors.grey,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            const Spacer(),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text(
                                  '฿${p.price.toStringAsFixed(0)}',
                                  style: const TextStyle(
                                    color: _kOrange,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                                (simple && qty > 0)
                                    ? Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          _qtyBtn(
                                            '−',
                                            () => _setQty(simpleKey!, qty - 1),
                                          ),
                                          Padding(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 6,
                                            ),
                                            child: Text(
                                              '$qty',
                                              style: const TextStyle(
                                                fontWeight: FontWeight.bold,
                                              ),
                                            ),
                                          ),
                                          _qtyBtn(
                                            '+',
                                            () => _addToCart(p),
                                            filled: true,
                                          ),
                                        ],
                                      )
                                    : InkWell(
                                        onTap: () => _addToCart(p),
                                        child: Container(
                                          width: 28,
                                          height: 28,
                                          decoration: const BoxDecoration(
                                            color: _kNavy,
                                            shape: BoxShape.circle,
                                          ),
                                          child: const Center(
                                            child: Text(
                                              '+',
                                              style: TextStyle(
                                                color: Colors.white,
                                                fontSize: 18,
                                                fontWeight: FontWeight.bold,
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _qtyBtn(String label, VoidCallback onTap, {bool filled = false}) {
    return InkWell(
      onTap: onTap,
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          color: filled ? _kNavy : Colors.white,
          border: Border.all(color: filled ? _kNavy : Colors.grey),
          shape: BoxShape.circle,
        ),
        child: Center(
          child: Text(
            label,
            style: TextStyle(
              color: filled ? Colors.white : Colors.black,
              fontSize: 13,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildCartBar(int qty, double total) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(.12),
            blurRadius: 12,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              decoration: const InputDecoration(
                hintText: '📝 หมายเหตุ (ทั้งออเดอร์)',
                border: OutlineInputBorder(),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
              ),
              onChanged: (v) => _orderNote = v,
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: _kNavy,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                onPressed: _placeOrder,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '🛒 ยืนยันออเดอร์ · $qty รายการ',
                      style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                      ),
                    ),
                    Text(
                      '฿${total.toStringAsFixed(0)}',
                      style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VariantOption {
  final String id; // '__base__' or v.name — stable key for radio
  final String label; // displayed text — 'ธรรมดา' or v.name
  final double price;
  final String? variantName; // null = base price, non-null = stored on order
  _VariantOption({
    required this.id,
    required this.label,
    required this.price,
    this.variantName,
  });
}

class _CartItem {
  final Product product;
  final int qty;
  final String note;
  final String? variantName;
  final List<OrderItemOption> optionsSelected;
  _CartItem({
    required this.product,
    required this.qty,
    required this.note,
    this.variantName,
    this.optionsSelected = const [],
  });
  _CartItem copyWith({int? qty, String? note}) => _CartItem(
    product: product,
    qty: qty ?? this.qty,
    note: note ?? this.note,
    variantName: variantName,
    optionsSelected: optionsSelected,
  );

  /// Stable key per (product, variant, options-combo). Different option picks
  /// are separate cart lines so the kitchen can split them.
  String get key {
    final opts = optionsSelected.map((o) => '${o.group}=${o.value}').join('|');
    return '${product.id}::${variantName ?? ''}::$opts';
  }

  double get unitPrice {
    if (variantName != null && product.variants != null) {
      final v = product.variants!
          .where((x) => x.name == variantName)
          .cast<Variant?>()
          .firstOrNull;
      if (v != null) return v.price + _optionDelta;
    }
    return product.price + _optionDelta;
  }

  double get _optionDelta =>
      optionsSelected.fold<double>(0, (sum, option) => sum + option.priceDelta);
}

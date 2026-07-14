import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../models/order.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/socket_service.dart';
import '../services/offline_repository.dart';
import '../services/print_helper.dart';
import '../services/bluetooth_printer_service.dart';
import '../services/sound_service.dart';
import '../theme.dart';
import 'bluetooth_printer_settings.dart';

const _activeStatuses = {'pending', 'cooking', 'served'};
const _statusLabel = {
  'pending': 'รอยืนยัน',
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
const _nextStatus = {
  'pending': ('cooking', '▶ เริ่มทำ'),
  'cooking': ('served', '✅ เสิร์ฟแล้ว'),
  'served': ('paid', '💰 ชำระแล้ว'),
};

String _fulfillmentText(String type) =>
    type == 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน';

Color _fulfillmentColor(String type) =>
    type == 'takeaway' ? const Color(0xFFF4A261) : const Color(0xFF06D6A0);

String _orderFulfillmentText(PosOrder order) {
  if (order.fulfillmentSummary == 'mixed') return 'ทานที่ร้าน + กลับบ้าน';
  if (order.fulfillmentSummary == 'takeaway') return 'กลับบ้าน';
  final types = order.items.map((it) => it.fulfillmentType).toSet();
  if (types.length > 1) return 'ทานที่ร้าน + กลับบ้าน';
  return _fulfillmentText(types.contains('takeaway') ? 'takeaway' : 'dine-in');
}

class KitchenScreen extends StatefulWidget {
  const KitchenScreen({super.key});

  @override
  State<KitchenScreen> createState() => _KitchenScreenState();
}

class _KitchenScreenState extends State<KitchenScreen>
    with WidgetsBindingObserver {
  late OfflineRepository _repo;
  late SocketService _socket;
  List<PosOrder> _orders = [];
  String? _error;
  bool _loading = true;
  bool _reloadInFlight = false;
  bool _reloadAgain = false;
  bool _lastSocketConnected = false;
  Timer? _pollTimer;
  final Set<int> _busyOrders = <int>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _repo = context.read<OfflineRepository>();
    _socket = context.read<SocketService>();
    _setupSocket();
    _bootstrap();
    _startFallbackPolling();
  }

  Future<void> _bootstrap() async {
    // Show cached data instantly if available, then refresh from API.
    final cached = await _repo.loadCached();
    if (mounted && cached.isNotEmpty) {
      setState(() {
        _orders = cached;
        _loading = false;
      });
    }
    unawaited(_reload());
  }

  void _setupSocket() {
    _lastSocketConnected = _socket.connected;
    _socket.addListener(_onSocketStateChanged);
    _socket.connect();
    _socket.on('order:new', _onSocketEvent);
    _socket.on('order:update', _onSocketEvent);
  }

  void _onSocketEvent(dynamic _) {
    unawaited(_reload(silent: true));
  }

  void _onSocketStateChanged() {
    final connected = _socket.connected;
    if (!_lastSocketConnected && connected) {
      unawaited(_reload(silent: true));
    }
    _lastSocketConnected = connected;
  }

  void _startFallbackPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      if (!mounted) return;
      if (!_socket.connected || !_repo.online) {
        _socket.connect();
        unawaited(_reload(silent: true));
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || !mounted) return;
    _socket.resume();
    unawaited(_reload());
  }

  @override
  void dispose() {
    _socket.off('order:new', _onSocketEvent);
    _socket.off('order:update', _onSocketEvent);
    _socket.removeListener(_onSocketStateChanged);
    _pollTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _reload({bool silent = false}) async {
    if (_reloadInFlight) {
      _reloadAgain = true;
      return;
    }
    _reloadInFlight = true;
    try {
      if (!silent && mounted && _orders.isEmpty) {
        setState(() => _loading = true);
      }
      final list = await _repo.refreshOrders();
      if (!mounted) return;
      setState(() {
        _orders = list;
        _loading = false;
        _error = _repo.online ? null : 'offline - ใช้ข้อมูลที่ cache ไว้';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    } finally {
      _reloadInFlight = false;
      if (_reloadAgain && mounted) {
        _reloadAgain = false;
        unawaited(_reload(silent: true));
      }
    }
  }

  Future<void> _changeStatus(int id, String status) async {
    if (_busyOrders.contains(id)) return;
    final before = List<PosOrder>.from(_orders);
    setState(() {
      _busyOrders.add(id);
      _orders = _orders
          .map((o) => o.id == id ? o.copyWith(status: status) : o)
          .toList();
    });
    try {
      await _repo.updateOrderStatus(id, status);
      final cached = await _repo.loadCached();
      if (!mounted) return;
      setState(() {
        _orders = cached.isEmpty ? _orders : cached;
        _error = _repo.online ? null : 'offline - ใช้ข้อมูลที่ cache ไว้';
      });
      unawaited(_reload(silent: true));
      if (!_repo.online) {
        _showSnack('ออฟไลน์ - เก็บคิวไว้ จะ sync เมื่อกลับมาออนไลน์');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _orders = before;
        _error = e.toString();
      });
      _showSnack(e.toString());
    } finally {
      _busyOrders.remove(id);
      if (mounted) setState(() {});
    }
  }

  Future<void> _printOrder(int id) async {
    final msg = await printOrder(
      context: context,
      api: _repo.api,
      orderId: id,
      type: 'kitchen',
    );
    _showSnack(msg);
  }

  void _showSnack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _logout() async {
    final auth = context.read<AuthService>();
    final socket = context.read<SocketService>();
    await auth.logout();
    socket.disconnect();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();
    final socketStatus = context.watch<SocketService>().connected;
    final repo = context.watch<OfflineRepository>();
    final active = _orders
        .where((o) => _activeStatuses.contains(o.status))
        .toList();

    return Scaffold(
      backgroundColor: PosColors.darkBg,
      body: SafeArea(
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [PosColors.darkSurface, PosColors.darkSurface2],
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black38,
                    blurRadius: 16,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                children: [
                  const Text('🍳', style: TextStyle(fontSize: 22)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text(
                          'ห้องครัว',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 18,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          '${active.length} ออเดอร์ · ${auth.user?.fullName ?? auth.user?.username ?? ""}'
                          ' · ${repo.online ? (socketStatus ? "🟢 live" : "🟡 polling") : "🔴 offline"}'
                          '${repo.pendingCount > 0 ? " · ⏳ ${repo.pendingCount} pending" : ""}',
                          style: const TextStyle(
                            color: Colors.white54,
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ),
                  // Printer settings — Kitchen role NEEDS this (was missing)
                  Stack(
                    children: [
                      IconButton(
                        onPressed: () {
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => BluetoothPrinterSettings(
                                api: ApiService(context.read<AuthService>()),
                                wrapInScaffold: true,
                              ),
                            ),
                          );
                        },
                        tooltip: 'ตั้งค่าเครื่องพิมพ์',
                        icon: Icon(
                          Icons.print,
                          color:
                              context
                                  .watch<BluetoothPrinterService>()
                                  .hasPrinter
                              ? const Color(0xFF06D6A0)
                              : Colors.white70,
                        ),
                      ),
                      if (context.watch<BluetoothPrinterService>().hasPrinter)
                        const Positioned(
                          right: 8,
                          top: 8,
                          child: Icon(
                            Icons.bluetooth,
                            size: 10,
                            color: Color(0xFF06D6A0),
                          ),
                        ),
                    ],
                  ),
                  const SoundToggleButton(color: Colors.white70),
                  IconButton(
                    onPressed: () => unawaited(_reload()),
                    tooltip: 'Reload',
                    icon: const Icon(Icons.refresh, color: Colors.white70),
                  ),
                  IconButton(
                    onPressed: _logout,
                    tooltip: 'ออก',
                    icon: const Icon(Icons.logout, color: Color(0xFFEF476F)),
                  ),
                ],
              ),
            ),
            if (_error != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                color: const Color(0xFF3A1820),
                child: Text(
                  _error!,
                  style: const TextStyle(
                    color: Color(0xFFEF476F),
                    fontSize: 12,
                  ),
                ),
              ),
            Expanded(
              child: _loading
                  ? const Center(
                      child: CircularProgressIndicator(color: Colors.white),
                    )
                  : active.isEmpty
                  ? const Center(
                      child: Text(
                        'ไม่มีออเดอร์รอดำเนินการ 🎉',
                        style: TextStyle(color: Colors.white30, fontSize: 16),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: () => _reload(),
                      child: LayoutBuilder(
                        builder: (ctx, c) {
                          final cols = c.maxWidth ~/ 320;
                          return GridView.count(
                            padding: const EdgeInsets.all(12),
                            crossAxisCount: cols < 1 ? 1 : cols,
                            mainAxisSpacing: 12,
                            crossAxisSpacing: 12,
                            childAspectRatio: 0.85,
                            children: active
                                .map(
                                  (o) => _OrderCard(
                                    order: o,
                                    busy: _busyOrders.contains(o.id),
                                    onChangeStatus: _changeStatus,
                                    onPrint: _printOrder,
                                  ),
                                )
                                .toList(),
                          );
                        },
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OrderCard extends StatelessWidget {
  final PosOrder order;
  final bool busy;
  final void Function(int id, String status) onChangeStatus;
  final void Function(int id) onPrint;

  const _OrderCard({
    required this.order,
    required this.busy,
    required this.onChangeStatus,
    required this.onPrint,
  });

  @override
  Widget build(BuildContext context) {
    final stColor = _statusColor[order.status] ?? Colors.grey;
    final next = _nextStatus[order.status];
    final timeStr = DateFormat('HH:mm').format(order.createdAt.toLocal());

    return Container(
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: .05),
        borderRadius: BorderRadius.circular(18),
        border: Border(
          top: const BorderSide(color: Color(0x14FFFFFF)),
          right: const BorderSide(color: Color(0x14FFFFFF)),
          bottom: const BorderSide(color: Color(0x14FFFFFF)),
          left: BorderSide(color: stColor, width: 4),
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x4D000000),
            blurRadius: 30,
            offset: Offset(0, 10),
          ),
        ],
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      order.tableName,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      'ลำดับ ${order.dailySeq} · #${order.id} · $timeStr',
                      style: const TextStyle(
                        color: Colors.white38,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                margin: const EdgeInsets.only(right: 8),
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                  color: _fulfillmentColor(
                    order.fulfillmentSummary == 'takeaway'
                        ? 'takeaway'
                        : 'dine-in',
                  ).withOpacity(.16),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  _orderFulfillmentText(order),
                  style: TextStyle(
                    color: order.fulfillmentSummary == 'mixed'
                        ? const Color(0xFFFFD166)
                        : _fulfillmentColor(order.fulfillmentSummary),
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                decoration: BoxDecoration(
                  color: stColor,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  _statusLabel[order.status] ?? order.status,
                  style: const TextStyle(
                    color: Color(0xFF1A1A2E),
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Expanded(
            child: ListView.builder(
              padding: EdgeInsets.zero,
              itemCount: order.items.length + (order.note != null ? 1 : 0),
              itemBuilder: (_, i) {
                if (i < order.items.length) {
                  final it = order.items[i];
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                '${it.productName} × ${it.quantity}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 14,
                                ),
                              ),
                            ),
                            Text(
                              '฿${(it.unitPrice * it.quantity).toStringAsFixed(0)}',
                              style: const TextStyle(
                                color: Colors.white54,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                        if (it.note != null && it.note!.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              '📝 ${it.note}',
                              style: const TextStyle(
                                color: Color(0xFFFFD166),
                                fontSize: 12,
                              ),
                            ),
                          ),
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: _fulfillmentColor(
                                it.fulfillmentType,
                              ).withOpacity(.16),
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              it.fulfillmentType == 'takeaway'
                                  ? '🛍️ กลับบ้าน'
                                  : '🍽️ ทานที่ร้าน',
                              style: TextStyle(
                                color: _fulfillmentColor(it.fulfillmentType),
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                }
                return Container(
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFD166).withOpacity(.1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    '📝 ${order.note}',
                    style: const TextStyle(
                      color: Color(0xFFFFD166),
                      fontSize: 12,
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (next != null)
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: _statusColor[next.$1] ?? Colors.grey,
                      foregroundColor: const Color(0xFF1A1A2E),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                      ),
                      padding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                    onPressed: busy
                        ? null
                        : () => onChangeStatus(order.id, next.$1),
                    child: busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(
                            next.$2,
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                  ),
                ),
              const SizedBox(width: 6),
              IconButton(
                onPressed: busy ? null : () => onPrint(order.id),
                style: IconButton.styleFrom(
                  backgroundColor: Colors.white.withOpacity(.1),
                ),
                icon: const Text('🖨️', style: TextStyle(fontSize: 18)),
                tooltip: 'พิมพ์ใบสั่งครัว',
              ),
              IconButton(
                onPressed: busy
                    ? null
                    : () => onChangeStatus(order.id, 'cancelled'),
                style: IconButton.styleFrom(
                  backgroundColor: const Color(0xFFEF476F).withOpacity(.2),
                ),
                icon: const Icon(
                  Icons.close,
                  color: Color(0xFFEF476F),
                  size: 20,
                ),
                tooltip: 'ยกเลิก',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

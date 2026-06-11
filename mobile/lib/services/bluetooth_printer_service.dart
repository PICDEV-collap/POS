import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// BLE-based thermal/label printer service.
///
/// Targets AYIN A70Pro / IPRT label printers that advertise the FEE7 service
/// UUID (Tencent's BLE service used by many Chinese thermal/label printers).
///
/// Workflow:
///   1. scan() — start a 6-second BLE scan, returns devices that look like printers
///   2. selectPrinter() — save MAC + name + auto-suggest TSPL protocol
///   3. printBytes() — connect → discover services → find a write char →
///        send chunks (≤180 B per write, 30 ms gap) → optional disconnect
class BluetoothPrinterService extends ChangeNotifier {
  static const _kMac = 'bt_printer_mac';
  static const _kName = 'bt_printer_name';
  static const _kRenderMode = 'bt_printer_render_mode';
  static const _kProtocol = 'bt_printer_protocol';
  static const _kLabelW = 'bt_printer_label_w_mm';
  static const _kLabelH = 'bt_printer_label_h_mm'; // 0 = auto-fit content
  static const _kGap = 'bt_printer_gap_mm'; // 0 = continuous
  static const _kBline = 'bt_printer_bline_mm';
  static const _kPaperType = 'bt_printer_paper_type'; // continuous|gap|bline
  static const _kSafeProtocolV2 = 'bt_printer_safe_protocol_v2';
  static const _kTsplAiyinV3 = 'bt_printer_tspl_aiyin_v3';
  // Auto-print this BLE printer when an order:new socket event arrives.
  // Defaults to false — admin must opt in from the printer settings screen.
  static const _kAutoPrintKitchen = 'bt_auto_print_kitchen';
  static const _kAutoPrintReceipt = 'bt_auto_print_receipt';

  // 203 DPI thermal printers print at 8 dots/mm.
  static const int _dotsPerMm = 8;

  String? _mac;
  String? _name;
  int _labelWidthMm = 58;
  int _labelHeightMm = 0; // 0 = auto-fit content (receipt paper)
  int _gapMm = 0; // 2-3mm typical for die-cut labels
  int _blineMm = 0;
  String _paperType = 'continuous'; // continuous | gap | bline
  bool _autoPrintKitchen = false;
  bool _autoPrintReceipt = false;
  String _renderMode = 'image';
  String _protocol = 'escpos';
  bool _connected = false;
  String? _lastError;

  BluetoothDevice? _device;
  BluetoothCharacteristic? _writeChar;
  BluetoothCharacteristic? _flowChar;
  StreamSubscription<BluetoothConnectionState>? _connSub;
  StreamSubscription<List<int>>? _flowSub;
  Future<bool>? _connectFuture;
  Future<void> _printLock = Future.value();
  int _negotiatedMtu = 23;

  String? get mac => _mac;
  String? get name => _name;
  int get labelWidthMm => _labelWidthMm;
  int get labelHeightMm => _labelHeightMm;
  int get gapMm => _gapMm;
  int get blineMm => _blineMm;
  String get paperType => _paperType;
  bool get isContinuous => _paperType == 'continuous';
  bool get autoPrintKitchen => _autoPrintKitchen;
  bool get autoPrintReceipt => _autoPrintReceipt;
  String get renderMode => _renderMode;
  String get protocol => _protocol;
  bool get hasPrinter => _mac != null;
  bool get connected => _connected;
  String? get lastWriteCharUuid => _writeChar?.uuid.toString();
  String get lastNotifySummary => _flowChar != null ? 'flow-on' : 'no-notify';
  bool get isAiyinBlePrinter => looksLikeLabelPrinter;
  String? get lastError => _lastError;

  // Bitmap size derived from label width — render exactly to fit the paper.
  int get widthPx {
    // Most 58mm ESC/POS receipt printers expose a 384-dot printable area
    // (around 48mm), not the full paper width. Sending 464-dot bitmaps over
    // BLE is slower and can make text look smaller relative to the roll.
    if (autoProtocol == 'escpos' && autoPaperType == 'continuous') {
      if (_labelWidthMm <= 58) return 384;
      if (_labelWidthMm <= 80) return 576;
    }
    return _labelWidthMm * _dotsPerMm;
  }

  int get widthChars {
    // Approximate chars per row in monospaced 24px font: ~3mm per char.
    return (_labelWidthMm / 3).floor().clamp(16, 64);
  }

  // Backward-compat shim for any UI still asking for 58/80mm paper width.
  int get paperMm => _labelWidthMm;

  bool get looksLikeLabelPrinter {
    final n = (_name ?? '').toLowerCase();
    return n.contains('a70') ||
        n.contains('ayin') ||
        n.contains('iprt') ||
        n.contains('label') ||
        n.contains('xprinter') ||
        n.contains('-ble');
  }

  bool get _shouldForceEscposForBle {
    if (_protocol != 'tspl') return false;
    // TSPL expects die-cut labels; continuous receipt rolls need ESC/POS.
    if (_paperType == 'continuous') return true;
    final n = (_name ?? '').toLowerCase();
    // A70 Pro over BLE is typically a receipt printer (height 0 = roll).
    if (n.contains('a70') && _labelHeightMm <= 0) return true;
    return n.contains('mini-printer') ||
        n.contains('mini printer') ||
        n.contains('thermal') ||
        !looksLikeLabelPrinter;
  }

  /// Auto-print is a background path, so be conservative. Many "mini-printer"
  /// BLE devices expose printer-like names but are ESC/POS receipt printers.
  /// If they receive TSPL they print raw text such as SIZE/GAP/BITMAP.
  String get autoProtocol => _shouldForceEscposForBle ? 'escpos' : _protocol;
  String get autoRenderMode => autoProtocol == 'escpos' ? 'image' : _renderMode;
  String get autoPaperType =>
      autoProtocol == 'escpos' ? 'continuous' : _paperType;
  int get autoLabelHeightMm => autoProtocol == 'escpos' ? 0 : _labelHeightMm;
  int get autoGapMm => autoProtocol == 'escpos' ? 0 : _gapMm;
  int get autoBlineMm => autoProtocol == 'escpos' ? 0 : _blineMm;

  Future<void> bootstrap() async {
    final p = await SharedPreferences.getInstance();
    _mac = p.getString(_kMac);
    _name = p.getString(_kName);
    _renderMode = p.getString(_kRenderMode) ?? 'image';
    _protocol = p.getString(_kProtocol) ?? 'escpos';
    _labelWidthMm = p.getInt(_kLabelW) ?? 58;
    _labelHeightMm = p.getInt(_kLabelH) ?? 0;
    _gapMm = p.getInt(_kGap) ?? 0;
    _blineMm = p.getInt(_kBline) ?? 0;
    _paperType = p.getString(_kPaperType) ?? 'continuous';
    _autoPrintKitchen = p.getBool(_kAutoPrintKitchen) ?? false;
    // Receipts are manual-only by policy; staff/admin print them from the
    // explicit receipt button after payment/order review.
    _autoPrintReceipt = false;
    await p.setBool(_kAutoPrintReceipt, false);
    // v2 safe default: if an older build auto-selected TSPL, the printer may
    // print "SIZE/GAP/BITMAP" as text. Switch existing installs to ESC/POS
    // image once; users with true TSPL label printers can manually switch back.
    if (p.getBool(_kSafeProtocolV2) != true) {
      _protocol = 'escpos';
      _renderMode = 'image';
      _paperType = 'continuous';
      _labelHeightMm = 0;
      _gapMm = 0;
      await p.setString(_kProtocol, _protocol);
      await p.setString(_kRenderMode, _renderMode);
      await p.setString(_kPaperType, _paperType);
      await p.setInt(_kLabelH, _labelHeightMm);
      await p.setInt(_kGap, _gapMm);
      await p.setBool(_kSafeProtocolV2, true);
    }
    notifyListeners();
  }

  Future<void> setAutoPrint({bool? kitchen, bool? receipt}) async {
    if (kitchen != null) _autoPrintKitchen = kitchen;
    if (receipt != null) _autoPrintReceipt = false;
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kAutoPrintKitchen, _autoPrintKitchen);
    await p.setBool(_kAutoPrintReceipt, false);
    notifyListeners();
    if (hasPrinter && _autoPrintKitchen) {
      unawaited(warmUp());
    }
  }

  /// Sets the label dimensions. Optional `paperType` overrides auto-detect:
  /// - `continuous` → no gap/blackmark sensor (receipt rolls)
  /// - `gap` (default) → die-cut labels with gap detection (gapMm 2-3 typical)
  /// - `bline` → labels with black-mark detection (blineMm)
  Future<void> setLabelSize({
    required int widthMm,
    required int heightMm,
    int? gapMm,
    int? blineMm,
    String? paperType,
  }) async {
    _labelWidthMm = widthMm.clamp(20, 200);
    _labelHeightMm = heightMm < 0 ? 0 : heightMm.clamp(0, 300);
    if (gapMm != null) _gapMm = gapMm.clamp(0, 10);
    if (blineMm != null) _blineMm = blineMm.clamp(0, 10);
    if (paperType != null &&
        (paperType == 'continuous' ||
            paperType == 'gap' ||
            paperType == 'bline')) {
      _paperType = paperType;
    }
    final p = await SharedPreferences.getInstance();
    await p.setInt(_kLabelW, _labelWidthMm);
    await p.setInt(_kLabelH, _labelHeightMm);
    await p.setInt(_kGap, _gapMm);
    await p.setInt(_kBline, _blineMm);
    await p.setString(_kPaperType, _paperType);
    notifyListeners();
  }

  Future<void> setPaperType(String type) async {
    if (type != 'continuous' && type != 'gap' && type != 'bline') return;
    _paperType = type;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kPaperType, _paperType);
    notifyListeners();
  }

  Future<void> setRenderMode(String mode) async {
    _renderMode = (mode == 'image') ? 'image' : 'text';
    final p = await SharedPreferences.getInstance();
    await p.setString(_kRenderMode, _renderMode);
    notifyListeners();
  }

  Future<void> setProtocol(String protocol) async {
    _protocol = (protocol == 'tspl') ? 'tspl' : 'escpos';
    final p = await SharedPreferences.getInstance();
    await p.setString(_kProtocol, _protocol);
    notifyListeners();
  }

  /// Permissions for BLE scan/connect.
  ///
  /// Android 12+ (SDK 31+): only `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` are
  /// required. The manifest declares `BLUETOOTH_SCAN` with the
  /// `neverForLocation` flag, so requesting `Permission.location` returns
  /// **denied** by design — including it in the required set was the bug
  /// that blocked scanning on modern phones.
  ///
  /// Android 11- (SDK 30-): `bluetoothScan` / `bluetoothConnect` don't exist
  /// at runtime; `permission_handler` reports them as `granted` automatically
  /// when the legacy `BLUETOOTH` / `BLUETOOTH_ADMIN` install-time perms are
  /// present. Location *is* required for BLE scans on those versions, so we
  /// fall back to requesting it only if the modern set isn't granted.
  Future<bool> ensurePermissions() async {
    final scan = await Permission.bluetoothScan.request();
    final connect = await Permission.bluetoothConnect.request();
    final modernOk =
        (scan.isGranted || scan.isLimited) &&
        (connect.isGranted || connect.isLimited);
    if (modernOk) return true;
    // Legacy fallback (Android 11-): location is required for BLE scan.
    final loc = await Permission.locationWhenInUse.request();
    return loc.isGranted || loc.isLimited;
  }

  /// True if the user tapped "Don't ask again" on a required Bluetooth perm.
  /// In that case `request()` will keep returning denied — we have to send
  /// them to App Settings.
  Future<bool> permissionsPermanentlyDenied() async {
    final scan = await Permission.bluetoothScan.status;
    final connect = await Permission.bluetoothConnect.status;
    if (scan.isPermanentlyDenied || connect.isPermanentlyDenied) return true;
    // Legacy path
    final loc = await Permission.locationWhenInUse.status;
    return loc.isPermanentlyDenied;
  }

  Future<bool> isBluetoothOn() async {
    try {
      final state = await FlutterBluePlus.adapterState.first.timeout(
        const Duration(seconds: 2),
      );
      return state == BluetoothAdapterState.on;
    } catch (_) {
      return false;
    }
  }

  // Tencent FEE7 — service UUID broadcast by AYIN/IPRT/A70Pro BLE printers.
  static final Guid _kFee7Service = Guid(
    '0000fee7-0000-1000-8000-00805f9b34fb',
  );

  /// Known write channels (FEC7/FF02). Picking the wrong GATT char "succeeds"
  /// at the OS level but the printer never prints.
  static const _kWriteCharHints = ['fec7', 'ff02', 'ffc1', '18f1'];
  static const _kFlowCharHints = ['fec8', 'ff03'];
  static const _kPrinterServiceHints = ['fee7', 'ff00', '18f0'];

  /// Two-stage BLE scan:
  ///   Stage 1 (≤3s): filter by FEE7 service — fast hit on A70Pro/AYIN/IPRT.
  ///   Stage 2 (remaining): unfiltered scan as fallback for printers that
  ///   don't advertise FEE7 in their adv packet.
  /// Always returns the union (deduped by MAC).
  Future<List<ScanResult>> scan({
    Duration timeout = const Duration(seconds: 6),
  }) async {
    if (!await ensurePermissions()) {
      throw Exception('ต้องอนุญาต Bluetooth + Location');
    }
    if (!await isBluetoothOn()) {
      throw Exception('Bluetooth ปิดอยู่');
    }
    final found = <String, ScanResult>{};
    final stage1 = Duration(
      milliseconds: (timeout.inMilliseconds * 0.5).round(),
    );
    final stage2 = timeout - stage1;
    await _runScan(stage1, found, withServices: [_kFee7Service]);
    // If stage 1 already found a printer-like device, we still run stage 2
    // briefly so the user sees other nearby BT devices in the list — but
    // shorter, since the target is likely already there.
    final hasPrinter = found.values.any(_looksPrinter);
    final remaining = hasPrinter
        ? Duration(milliseconds: (stage2.inMilliseconds * 0.4).round())
        : stage2;
    if (remaining.inMilliseconds > 250) {
      await _runScan(remaining, found);
    }
    return found.values.toList();
  }

  Future<void> _runScan(
    Duration timeout,
    Map<String, ScanResult> found, {
    List<Guid> withServices = const [],
  }) async {
    try {
      await FlutterBluePlus.stopScan();
    } catch (_) {}
    final completer = Completer<void>();
    final sub = FlutterBluePlus.scanResults.listen((results) {
      for (final r in results) {
        if (r.device.platformName.isEmpty &&
            r.advertisementData.advName.isEmpty) {
          continue;
        }
        found[r.device.remoteId.str] = r;
      }
    });
    Timer(timeout, () async {
      try {
        await FlutterBluePlus.stopScan();
      } catch (_) {}
      sub.cancel();
      if (!completer.isCompleted) completer.complete();
    });
    await FlutterBluePlus.startScan(
      timeout: timeout,
      withServices: withServices,
    );
    return completer.future;
  }

  static bool namePrefersTsplBle(String name) {
    final n = name.toLowerCase();
    return n.contains('a70') ||
        n.contains('ayin') ||
        n.contains('iprt') ||
        n.contains('label') ||
        n.contains('xprinter') ||
        n.contains('-ble');
  }

  bool get _prefersTsplBle => namePrefersTsplBle(_name ?? '');

  static bool _looksPrinter(ScanResult r) {
    final n =
        (r.advertisementData.advName.isNotEmpty
                ? r.advertisementData.advName
                : r.device.platformName)
            .toLowerCase();
    return n.contains('a70') ||
        n.contains('ayin') ||
        n.contains('iprt') ||
        n.contains('label') ||
        n.contains('print') ||
        n.contains('xprinter') ||
        n.contains('-ble');
  }

  Future<void> selectPrinter(ScanResult r) async {
    final dev = r.device;
    final n = dev.advName.isNotEmpty ? dev.advName : dev.platformName;
    _mac = dev.remoteId.str;
    _name = n;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kMac, _mac!);
    await p.setString(_kName, _name ?? '');
    if (namePrefersTsplBle(n)) {
      _protocol = 'tspl';
      _renderMode = 'image';
      _paperType = 'continuous';
      _labelWidthMm = 58;
      _labelHeightMm = 0;
      _gapMm = 0;
    } else {
      _protocol = 'escpos';
      _renderMode = 'image';
      _paperType = 'continuous';
      _labelHeightMm = 0;
      _gapMm = 0;
    }
    await p.setString(_kProtocol, _protocol);
    await p.setString(_kRenderMode, _renderMode);
    await p.setString(_kPaperType, _paperType);
    await p.setInt(_kLabelW, _labelWidthMm);
    await p.setInt(_kLabelH, _labelHeightMm);
    await p.setInt(_kGap, _gapMm);
    await p.setBool(_kSafeProtocolV2, true);
    await p.setBool(_kTsplAiyinV3, true);
    await disconnect();
    notifyListeners();
  }

  Future<void> clearPrinter() async {
    await disconnect();
    _mac = null;
    _name = null;
    final p = await SharedPreferences.getInstance();
    await p.remove(_kMac);
    await p.remove(_kName);
    notifyListeners();
  }

  /// Re-apply TSPL for AiYin/A70 if an older build left protocol on ESC/POS.
  Future<void> ensureProtocolForDevice() async {
    if (!_prefersTsplBle || _protocol == 'tspl') return;
    _protocol = 'tspl';
    _renderMode = 'image';
    _paperType = 'continuous';
    _labelWidthMm = 58;
    _labelHeightMm = 0;
    _gapMm = 0;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kProtocol, _protocol);
    await p.setString(_kRenderMode, _renderMode);
    await p.setString(_kPaperType, _paperType);
    await p.setInt(_kLabelW, _labelWidthMm);
    await p.setInt(_kLabelH, _labelHeightMm);
    await p.setInt(_kGap, _gapMm);
    await p.setBool(_kTsplAiyinV3, true);
    notifyListeners();
  }

  Future<bool> warmUp() async {
    if (_mac == null) {
      _lastError = 'ยังไม่ได้เลือกเครื่องพิมพ์ Bluetooth';
      notifyListeners();
      return false;
    }
    await ensureProtocolForDevice();
    if (_connected && _writeChar != null) return true;
    return _connectAndDiscover();
  }

  /// Default BLE ATT MTU minus header → 20-byte chunks (safe for A70/FEC7).
  static const int _kDefaultMtu = 23;

  bool get _skipMtuNegotiation {
    final n = (_name ?? '').toLowerCase();
    return n.contains('a70') ||
        n.contains('ayin') ||
        n.contains('iprt') ||
        n.contains('-ble');
  }

  Future<int> _resolveMtu(BluetoothDevice device) async {
    if (_skipMtuNegotiation) {
      debugPrint(
        '[ble-printer] skip MTU negotiate ($_name) — use $_kDefaultMtu',
      );
      return _kDefaultMtu;
    }
    try {
      final mtu = await device
          .requestMtu(247)
          .timeout(const Duration(seconds: 2));
      return mtu.clamp(_kDefaultMtu, 247);
    } on TimeoutException {
      debugPrint('[ble-printer] MTU negotiate timed out — use $_kDefaultMtu');
    } catch (e) {
      debugPrint('[ble-printer] MTU negotiate failed: $e');
    }
    return _kDefaultMtu;
  }

  Future<bool> _connectAndDiscover() {
    final existing = _connectFuture;
    if (existing != null) return existing;
    final next = _doConnectAndDiscover();
    _connectFuture = next;
    next.whenComplete(() => _connectFuture = null);
    return next;
  }

  Future<bool> _doConnectAndDiscover() async {
    if (_mac == null) return false;
    try {
      _device = BluetoothDevice.fromId(_mac!);
      _connSub?.cancel();
      _connSub = _device!.connectionState.listen((s) {
        _connected = (s == BluetoothConnectionState.connected);
        notifyListeners();
      });
      await _device!.connect(
        license: License.nonprofit,
        timeout: const Duration(seconds: 8),
        autoConnect: false,
      );
      try {
        await _device!.requestConnectionPriority(
          connectionPriorityRequest: ConnectionPriority.high,
        );
      } catch (_) {}
      _negotiatedMtu = await _resolveMtu(_device!);
      await Future.delayed(const Duration(milliseconds: 150));

      // Discover services and find the printer write + optional flow-control chars.
      final services = await _device!.discoverServices();
      _flowChar = null;
      BluetoothCharacteristic? wc;
      for (final s in services) {
        final sid = s.uuid.toString().toLowerCase();
        if (!_kPrinterServiceHints.any(sid.contains)) continue;
        _flowChar ??= _findCharacteristic(
          s.characteristics,
          _kFlowCharHints,
          notify: true,
        );
        wc = _findCharacteristic(
          s.characteristics,
          _kWriteCharHints,
          write: true,
        );
        wc ??= _pickWriteCharacteristic(s.characteristics);
        if (wc != null) break;
      }
      if (wc == null) {
        for (final s in services) {
          _flowChar ??= _findCharacteristic(
            s.characteristics,
            _kFlowCharHints,
            notify: true,
          );
          wc = _pickWriteCharacteristic(s.characteristics);
          if (wc != null) break;
        }
      }
      if (wc == null) {
        _lastError = 'no write characteristic found';
        notifyListeners();
        return false;
      }
      _writeChar = wc;
      await _enableFlowControl();
      _connected = _device?.isConnected == true;
      _lastError = null;
      debugPrint(
        '[ble-printer] write=${wc.uuid} flow=${_flowChar?.uuid} '
        'w=${wc.properties.write} wnr=${wc.properties.writeWithoutResponse}',
      );
      notifyListeners();
      return true;
    } catch (e) {
      _connected = false;
      _lastError = e.toString();
      notifyListeners();
      return false;
    }
  }

  BluetoothCharacteristic? _findCharacteristic(
    List<BluetoothCharacteristic> chars,
    List<String> hints, {
    bool write = false,
    bool notify = false,
  }) {
    for (final hint in hints) {
      for (final c in chars) {
        if (!c.uuid.toString().toLowerCase().contains(hint)) continue;
        final p = c.properties;
        if (notify && (p.notify || p.indicate)) return c;
        if (write && (p.writeWithoutResponse || p.write)) return c;
      }
    }
    return null;
  }

  BluetoothCharacteristic? _pickWriteCharacteristic(
    List<BluetoothCharacteristic> chars,
  ) {
    BluetoothCharacteristic? withResponse;
    for (final c in chars) {
      final u = c.uuid.toString().toLowerCase();
      if (_kFlowCharHints.any(u.contains)) continue;
      final p = c.properties;
      if (p.writeWithoutResponse) return c;
      if (p.write) withResponse = c;
    }
    return withResponse;
  }

  Future<void> _enableFlowControl() async {
    _flowSub?.cancel();
    _flowSub = null;
    final fc = _flowChar;
    if (fc == null) return;
    try {
      await fc.setNotifyValue(true).timeout(const Duration(seconds: 3));
      _flowSub = fc.lastValueStream.listen((_) {});
      await Future.delayed(const Duration(milliseconds: 80));
    } on TimeoutException {
      debugPrint('[ble-printer] flow-control notify timed out — continue');
    } catch (e) {
      debugPrint('[ble-printer] flow-control notify failed: $e');
    }
  }

  Future<T> _withPrintLock<T>(Future<T> Function() action) async {
    final previous = _printLock;
    final completer = Completer<void>();
    _printLock = completer.future;
    try {
      await previous.catchError((_) {});
      return await action();
    } finally {
      if (!completer.isCompleted) completer.complete();
    }
  }

  Future<void> _settleAfterWrite(int byteLength) async {
    final ms = byteLength > 18000
        ? 1200
        : byteLength > 12000
        ? 900
        : byteLength > 4000
        ? 500
        : 250;
    await Future.delayed(Duration(milliseconds: ms));
  }

  static const _kPostPrintFeed = <int>[0x1b, 0x64, 0x04];

  Future<bool> printBytes(List<int> bytes, {bool acceptPartialWrite = false}) {
    return _withPrintLock(
      () => _printBytesLocked(bytes, acceptPartialWrite: acceptPartialWrite),
    );
  }

  Future<bool> _printBytesLocked(
    List<int> bytes, {
    bool acceptPartialWrite = false,
  }) async {
    if (_mac == null) {
      _lastError = 'no printer paired';
      notifyListeners();
      return false;
    }
    if (_writeChar == null || !_connected) {
      if (!await _connectAndDiscover()) return false;
    }

    if (bytes.length < 8) {
      _lastError = 'payload too small (${bytes.length} bytes)';
      notifyListeners();
      return false;
    }

    final ok = await _writeChunked(bytes);
    if (ok) {
      await _writeChunked(_kPostPrintFeed, flushOnly: true);
      await _settleAfterWrite(bytes.length);
      return true;
    }

    // Retry: full reconnect
    await disconnect();
    await Future.delayed(const Duration(milliseconds: 400));
    if (!await _connectAndDiscover()) return false;
    final retryOk = await _writeChunked(bytes);
    if (retryOk) {
      await _writeChunked(_kPostPrintFeed, flushOnly: true);
      await _settleAfterWrite(bytes.length);
    }
    return retryOk;
  }

  Future<bool> _writeChunked(List<int> bytes, {bool flushOnly = false}) async {
    if (_writeChar == null) return false;
    final props = _writeChar!.properties;
    // FEE7/FEC7 and FF00/FF02 printers expect writeWithoutResponse.
    final withoutResponse = props.writeWithoutResponse || !props.write;
    final mtuPayload = (_negotiatedMtu - 3).clamp(10, 247).toInt();
    final chunk = withoutResponse
        ? mtuPayload.clamp(10, 20)
        : mtuPayload.clamp(20, 180);
    final expectedChunks = (bytes.length / chunk).ceil();
    final sw = Stopwatch()..start();
    var chunks = 0;
    try {
      for (var i = 0; i < bytes.length; i += chunk) {
        final end = (i + chunk < bytes.length) ? i + chunk : bytes.length;
        await _writeChar!.write(
          bytes.sublist(i, end),
          withoutResponse: withoutResponse,
          timeout: 15,
        );
        chunks += 1;
        if (i + chunk < bytes.length || flushOnly) {
          final gapMs = withoutResponse ? 14 : 6;
          await Future.delayed(Duration(milliseconds: gapMs));
        }
      }
      if (!flushOnly &&
          chunks < expectedChunks &&
          chunks < (expectedChunks * 0.95).floor()) {
        _lastError =
            'ส่งข้อมูลไม่ครบ ($chunks/$expectedChunks chunks) — กระดาษอาจไม่ออก';
        notifyListeners();
        return false;
      }
      debugPrint(
        '[ble-printer] sent bytes=${bytes.length} chunks=$chunks/$expectedChunks '
        'chunk=$chunk mtu=$_negotiatedMtu char=${_writeChar!.uuid} '
        'mode=${withoutResponse ? "writeWithoutResponse" : "writeWithResponse"} '
        'elapsed_ms=${sw.elapsedMilliseconds}',
      );
      _lastError = null;
      notifyListeners();
      return true;
    } catch (e) {
      _lastError = 'write failed: $e';
      debugPrint(
        '[ble-printer] write failed bytes=${bytes.length} chunks=$chunks/$expectedChunks '
        'chunk=$chunk mtu=$_negotiatedMtu char=${_writeChar!.uuid} '
        'mode=${withoutResponse ? "writeWithoutResponse" : "writeWithResponse"} '
        'error=$e',
      );
      notifyListeners();
      if (chunks > 0 &&
          !flushOnly &&
          chunks >= (expectedChunks * 0.95).floor()) {
        debugPrint('[ble-printer] near-complete write despite error — accept');
        _lastError = null;
        notifyListeners();
        return true;
      }
      return false;
    }
  }

  /// TSPL continuous-roll setup — config only (no PRINT), Expert Label style.
  List<int> continuousPaperSetupBytes({int? labelWidthMm}) {
    final w = labelWidthMm ?? _labelWidthMm;
    return utf8.encode(
      'SIZE $w mm, 10 mm\r\n'
      'GAP 0,0\r\n'
      'BLINE 0,0\r\n'
      'SET GAP OFF\r\n'
      'SET CUTTER OFF\r\n'
      'SET PEEL OFF\r\n'
      'SET TEAR ON\r\n'
      'DIRECTION 0\r\n'
      'REFERENCE 0,0\r\n',
    );
  }

  Future<bool> setupContinuousPaper() =>
      printBytes(continuousPaperSetupBytes());

  Future<bool> printBase64(
    String b64, {
    bool acceptPartialWrite = false,
  }) async {
    return printBytes(
      base64.decode(b64),
      acceptPartialWrite: acceptPartialWrite,
    );
  }

  Future<void> disconnect() async {
    try {
      await _device?.disconnect();
    } catch (_) {}
    _connSub?.cancel();
    _connSub = null;
    _flowSub?.cancel();
    _flowSub = null;
    _device = null;
    _writeChar = null;
    _flowChar = null;
    _connected = false;
    notifyListeners();
  }
}

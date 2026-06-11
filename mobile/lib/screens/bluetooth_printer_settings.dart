import 'package:app_settings/app_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';
import '../services/bluetooth_printer_service.dart';

const _kNavy = Color(0xFF1A1A2E);
const _kGreen = Color(0xFF06D6A0);
const _kOrange = Color(0xFFE85D04);

class _LabelPreset {
  final String label;
  final int widthMm;
  final int heightMm; // 0 = auto-fit
  final int gapMm;
  final String paperType; // continuous | gap | bline
  const _LabelPreset(
    this.label,
    this.widthMm,
    this.heightMm,
    this.gapMm,
    this.paperType,
  );
}

class BluetoothPrinterSettings extends StatefulWidget {
  final ApiService api;
  final bool wrapInScaffold;
  const BluetoothPrinterSettings({
    super.key,
    required this.api,
    this.wrapInScaffold = false,
  });
  @override
  State<BluetoothPrinterSettings> createState() =>
      _BluetoothPrinterSettingsState();
}

class _BluetoothPrinterSettingsState extends State<BluetoothPrinterSettings> {
  bool _scanning = false;
  bool? _btOn;
  bool? _permOk;
  List<ScanResult> _found = [];
  String? _err;

  @override
  void initState() {
    super.initState();
    _scan();
  }

  Future<void> _scan() async {
    final svc = context.read<BluetoothPrinterService>();
    setState(() {
      _scanning = true;
      _err = null;
      _found = [];
    });
    try {
      _permOk = await svc.ensurePermissions();
      _btOn = await svc.isBluetoothOn();
      if (_permOk != true) {
        final permanently = await svc.permissionsPermanentlyDenied();
        setState(() {
          _err = permanently
              ? 'สิทธิ์ Bluetooth ถูกปฏิเสธถาวร — กด "เปิดการตั้งค่า" แล้วเปิด Bluetooth/Nearby devices ให้แอป'
              : 'ต้องอนุญาต Bluetooth (Android 12+) หรือ Bluetooth + Location (Android 11-)';
        });
        return;
      }
      if (_btOn != true) {
        setState(() {
          _err = 'Bluetooth ปิดอยู่';
        });
        return;
      }
      final list = await svc.scan();
      // Sort: printer-like names first, then by signal strength
      list.sort((a, b) {
        bool aLooksPrinter = _isLikelyPrinter(a);
        bool bLooksPrinter = _isLikelyPrinter(b);
        if (aLooksPrinter != bLooksPrinter) return aLooksPrinter ? -1 : 1;
        return b.rssi.compareTo(a.rssi);
      });
      if (!mounted) return;
      setState(() {
        _found = list;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _err = e.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _scanning = false;
        });
      }
    }
  }

  bool _isLikelyPrinter(ScanResult r) {
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
        n.contains('xprinter');
  }

  Future<void> _testPrint() async {
    final svc = context.read<BluetoothPrinterService>();
    if (!svc.hasPrinter) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('ยังไม่ได้เลือกเครื่องพิมพ์')),
      );
      return;
    }
    try {
      final payload = await widget.api.getTestPrintPayload(
        widthPx: svc.widthPx,
        widthChars: svc.widthChars,
        renderMode: svc.renderMode,
        protocol: svc.protocol,
        labelWidthMm: svc.labelWidthMm,
        labelHeightMm: svc.labelHeightMm,
        gapMm: svc.gapMm,
        blineMm: svc.blineMm,
        paperType: svc.paperType,
      );
      final ok = await svc.printBase64(payload['bytes_base64'] as String);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            ok
                ? '✅ พิมพ์สำเร็จ (${payload['bytes_length']} bytes)'
                : '❌ ${svc.lastError}',
          ),
          backgroundColor: ok ? _kGreen : Colors.red,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _calibratePrinter() async {
    final svc = context.read<BluetoothPrinterService>();
    if (!svc.hasPrinter) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('ยังไม่ได้เลือกเครื่องพิมพ์')),
      );
      return;
    }
    if (svc.protocol != 'tspl') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Calibrate ใช้ได้กับ TSPL เท่านั้น')),
      );
      return;
    }
    if (svc.paperType == 'continuous') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'กระดาษต่อเนื่องไม่ต้อง calibrate — ปิด sensor อยู่แล้ว',
          ),
        ),
      );
      return;
    }
    try {
      final payload = await widget.api.getCalibratePayload(
        paperType: svc.paperType,
        labelWidthMm: svc.labelWidthMm,
        labelHeightMm: svc.labelHeightMm,
      );
      final ok = await svc.printBase64(payload['bytes_base64'] as String);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            ok
                ? '🔧 ส่งคำสั่ง calibrate แล้ว — ดูเครื่องพิมพ์เดินกระดาษ'
                : '❌ ${svc.lastError}',
          ),
          backgroundColor: ok ? _kGreen : Colors.red,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _openOsBluetoothSettings() async {
    try {
      await AppSettings.openAppSettings(type: AppSettingsType.bluetooth);
    } catch (_) {
      try {
        await AppSettings.openAppSettings();
      } catch (_) {}
    }
  }

  /// Try to grant permissions; if the user has tapped "Don't ask again",
  /// the OS won't show the dialog anymore — fall through to App Settings.
  Future<void> _requestOrOpenSettings() async {
    final svc = context.read<BluetoothPrinterService>();
    final ok = await svc.ensurePermissions();
    if (!mounted) return;
    if (ok) {
      _scan();
      return;
    }
    if (await svc.permissionsPermanentlyDenied()) {
      try {
        await AppSettings.openAppSettings(type: AppSettingsType.settings);
      } catch (_) {
        try {
          await AppSettings.openAppSettings();
        } catch (_) {}
      }
    } else {
      // First-time deny — re-running scan will trigger the system dialog again.
      _scan();
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = _buildBody();
    if (!widget.wrapInScaffold) return body;
    return Scaffold(
      appBar: AppBar(
        title: const Text('ตั้งค่าเครื่องพิมพ์ BLE'),
        backgroundColor: _kNavy,
        foregroundColor: Colors.white,
      ),
      body: body,
    );
  }

  Widget _buildBody() {
    final svc = context.watch<BluetoothPrinterService>();
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        _statusCard(svc),
        const SizedBox(height: 8),
        _autoPrintCard(svc),
        const SizedBox(height: 8),
        _paperWidthCard(svc),
        const SizedBox(height: 8),
        _selectedPrinterCard(svc),
        if (svc.hasPrinter)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(
                backgroundColor: _kNavy,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: _testPrint,
              icon: const Icon(Icons.print),
              label: const Text(
                '🖨️ ทดสอบพิมพ์ (BLE)',
                style: TextStyle(fontWeight: FontWeight.bold),
              ),
            ),
          ),
        const SizedBox(height: 12),
        _scannedDevicesSection(svc),
        const SizedBox(height: 12),
        _instructionsCard(),
      ],
    );
  }

  Widget _statusCard(BluetoothPrinterService svc) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'สถานะ Bluetooth (BLE)',
              style: TextStyle(
                fontSize: 13,
                color: Colors.grey,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            _statusRow(
              'Bluetooth',
              _btOn,
              okLabel: '🟢 เปิดอยู่',
              failLabel: '🔴 ปิด',
              actionLabel: 'เปิด',
              action: _openOsBluetoothSettings,
            ),
            _statusRow(
              'สิทธิ์',
              _permOk,
              okLabel: '🟢 อนุญาตแล้ว',
              failLabel: '🔴 ยังไม่อนุญาต',
              actionLabel: 'ขอสิทธิ์',
              action: _requestOrOpenSettings,
            ),
            _statusRow(
              'อุปกรณ์ที่พบ',
              _found.isNotEmpty,
              okLabel: '🟢 ${_found.length} เครื่อง',
              failLabel: '⚪ 0 เครื่อง',
              actionLabel: 'รีเฟรช',
              action: _scan,
            ),
            if (_err != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFE5E5),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    _err!,
                    style: const TextStyle(color: Colors.red, fontSize: 12),
                  ),
                ),
              ),
            const SizedBox(height: 8),
            ElevatedButton.icon(
              onPressed: _scanning ? null : _scan,
              icon: _scanning
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.bluetooth_searching),
              label: Text(
                _scanning ? 'กำลังสแกน BLE (~6 วิ)...' : '🔍 สแกน BLE',
              ),
              style: ElevatedButton.styleFrom(
                backgroundColor: _kNavy,
                foregroundColor: Colors.white,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusRow(
    String label,
    bool? ok, {
    required String okLabel,
    required String failLabel,
    String? actionLabel,
    Future<void> Function()? action,
  }) {
    final isOk = ok == true;
    final status = ok == null ? '...' : (isOk ? okLabel : failLabel);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(label, style: const TextStyle(fontSize: 13)),
          ),
          Expanded(child: Text(status, style: const TextStyle(fontSize: 13))),
          if (!isOk && actionLabel != null && action != null)
            TextButton(
              onPressed: action,
              child: Text(actionLabel, style: const TextStyle(fontSize: 12)),
            ),
        ],
      ),
    );
  }

  Widget _autoPrintCard(BluetoothPrinterService svc) {
    return Card(
      color: const Color(0xFFFFFBEB),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '🤖 พิมพ์อัตโนมัติเมื่อมีออเดอร์ใหม่',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            const Text(
              'เมื่อเปิด แอปจะพิมพ์อัตโนมัติทุกครั้งที่มี order:new event '
              '(ทั้งจากลูกค้า QR และ staff สั่งแทน) — ใช้ที่เคาน์เตอร์ครัวที่เปิดแอปไว้ตลอด '
              'เวอร์ชันนี้กันจอดับเพื่อไม่ให้ socket/BLE หลุด',
              style: TextStyle(fontSize: 11, color: Colors.grey),
            ),
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: Color(0xFFE8F5E9),
                borderRadius: BorderRadius.all(Radius.circular(6)),
              ),
              child: Text(
                'วางเครื่องชาร์จและเปิดหน้า Staff/Kitchen ค้างไว้ หากกดล็อกจอหรือสลับแอปนาน Android อาจพัก Bluetooth',
                style: TextStyle(fontSize: 11, color: Color(0xFF2E7D32)),
              ),
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: const Text('🍳 พิมพ์ใบครัว'),
              value: svc.autoPrintKitchen,
              onChanged: svc.hasPrinter
                  ? (v) => svc.setAutoPrint(kitchen: v)
                  : null,
            ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: const Text('🧾 พิมพ์ใบเสร็จลูกค้า'),
              subtitle: const Text(
                'ทั่วไปปิดไว้ — พิมพ์ตอนชำระแล้วจะตรงกว่า',
                style: TextStyle(fontSize: 10),
              ),
              value: svc.autoPrintReceipt,
              onChanged: svc.hasPrinter
                  ? (v) => svc.setAutoPrint(receipt: v)
                  : null,
            ),
            if (!svc.hasPrinter)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  '⚠️ ยังไม่ได้เลือกเครื่องพิมพ์ — เลือกด้านล่างก่อน',
                  style: TextStyle(fontSize: 11, color: Colors.red),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _paperWidthCard(BluetoothPrinterService svc) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '🔌 Protocol',
              style: TextStyle(
                fontSize: 13,
                color: Colors.grey,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'tspl', label: Text('TSPL')),
                ButtonSegment(value: 'escpos', label: Text('ESC/POS')),
              ],
              selected: {svc.protocol},
              onSelectionChanged: (s) => svc.setProtocol(s.first),
            ),
            const SizedBox(height: 6),
            Text(
              svc.protocol == 'tspl'
                  ? 'TSPL — ใช้เฉพาะเครื่องที่รับ TSPL จริง ถ้าพิมพ์คำว่า SIZE/GAP/BITMAP ให้เปลี่ยนเป็น ESC/POS'
                  : 'ESC/POS — แนะนำสำหรับเครื่องใบเสร็จ/BLE ในร้าน ใช้ image mode เพื่อภาษาไทย',
              style: const TextStyle(fontSize: 11, color: Colors.grey),
            ),
            if (svc.protocol == 'tspl') ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFF3E0),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFFFFB74D)),
                ),
                child: const Text(
                  'ถ้าใบพิมพ์ออกมาเป็นข้อความ SIZE / GAP / BITMAP แปลว่าเครื่องไม่ได้อยู่โหมด TSPL ให้เลือก ESC/POS',
                  style: TextStyle(fontSize: 11, color: Color(0xFFE65100)),
                ),
              ),
            ],
            const Divider(height: 24),
            _paperTypeSelector(svc),
            const SizedBox(height: 14),
            const Text(
              '🏷️ ขนาดกระดาษ / ฉลาก',
              style: TextStyle(
                fontSize: 13,
                color: Colors.grey,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            _labelPresetChips(svc),
            const SizedBox(height: 8),
            _labelCustomFields(svc),
            const SizedBox(height: 6),
            Text(
              'ตอนนี้: ${svc.labelWidthMm}mm × ${svc.labelHeightMm == 0 ? "auto" : "${svc.labelHeightMm}mm"}'
              '  · ${svc.paperType}  · ${svc.widthPx}px',
              style: const TextStyle(fontSize: 11, color: Colors.grey),
            ),
            if (svc.hasPrinter &&
                svc.protocol == 'tspl' &&
                svc.paperType != 'continuous') ...[
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: _calibratePrinter,
                icon: const Icon(Icons.tune),
                label: const Text('🔧 Calibrate sensor (หลังเปลี่ยนกระดาษ)'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: _kOrange,
                  side: const BorderSide(color: _kOrange),
                  padding: const EdgeInsets.symmetric(vertical: 10),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  // Common label sizes — width × height + sensor type.
  // Continuous: receipt rolls (no gap detection). Gap: die-cut labels.
  static const _labelPresets = <_LabelPreset>[
    _LabelPreset('58mm ต่อเนื่อง', 58, 0, 0, 'continuous'),
    _LabelPreset('80mm ต่อเนื่อง', 80, 0, 0, 'continuous'),
    _LabelPreset('30×20', 30, 20, 2, 'gap'),
    _LabelPreset('40×30', 40, 30, 2, 'gap'),
    _LabelPreset('50×30', 50, 30, 2, 'gap'),
    _LabelPreset('60×30', 60, 30, 2, 'gap'),
    _LabelPreset('60×40', 60, 40, 2, 'gap'),
    _LabelPreset('75×60', 75, 60, 3, 'gap'),
  ];

  Widget _labelPresetChips(BluetoothPrinterService svc) {
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: _labelPresets.map((p) {
        final isSelected =
            svc.labelWidthMm == p.widthMm &&
            svc.labelHeightMm == p.heightMm &&
            svc.paperType == p.paperType;
        return ChoiceChip(
          label: Text(p.label, style: const TextStyle(fontSize: 12)),
          selected: isSelected,
          onSelected: (_) => svc.setLabelSize(
            widthMm: p.widthMm,
            heightMm: p.heightMm,
            gapMm: p.gapMm,
            paperType: p.paperType,
          ),
        );
      }).toList(),
    );
  }

  Widget _paperTypeSelector(BluetoothPrinterService svc) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '📄 ชนิดกระดาษ (sensor)',
          style: TextStyle(
            fontSize: 13,
            color: Colors.grey,
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 6),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(
              value: 'continuous',
              label: Text('ต่อเนื่อง', style: TextStyle(fontSize: 11)),
            ),
            ButtonSegment(
              value: 'gap',
              label: Text('ฉลาก (gap)', style: TextStyle(fontSize: 11)),
            ),
            ButtonSegment(
              value: 'bline',
              label: Text('Black mark', style: TextStyle(fontSize: 11)),
            ),
          ],
          selected: {svc.paperType},
          onSelectionChanged: (s) => svc.setPaperType(s.first),
        ),
        const SizedBox(height: 4),
        Text(
          svc.paperType == 'continuous'
              ? '📜 ต่อเนื่อง — ปิด sensor (`GAP 0,0` + `SET TEAR ON`)'
              : svc.paperType == 'bline'
              ? '⬛ มีแถบดำที่หลังกระดาษ — `BLINE ${svc.blineMm}mm`'
              : '🏷️ ฉลาก die-cut — `GAP ${svc.gapMm}mm`',
          style: const TextStyle(fontSize: 11, color: Colors.grey),
        ),
      ],
    );
  }

  Widget _labelCustomFields(BluetoothPrinterService svc) {
    return Row(
      children: [
        Expanded(
          child: _numField(
            'กว้าง (mm)',
            svc.labelWidthMm,
            (v) => svc.setLabelSize(
              widthMm: v,
              heightMm: svc.labelHeightMm,
              gapMm: svc.gapMm,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _numField(
            'สูง (mm) · 0=auto',
            svc.labelHeightMm,
            (v) => svc.setLabelSize(
              widthMm: svc.labelWidthMm,
              heightMm: v,
              gapMm: svc.gapMm,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _numField(
            'Gap (mm)',
            svc.gapMm,
            (v) => svc.setLabelSize(
              widthMm: svc.labelWidthMm,
              heightMm: svc.labelHeightMm,
              gapMm: v,
            ),
          ),
        ),
      ],
    );
  }

  Widget _numField(
    String label,
    int value,
    Future<void> Function(int) onSubmit,
  ) {
    return TextField(
      key: ValueKey('numfield-$label-$value'),
      controller: TextEditingController(text: value.toString()),
      decoration: InputDecoration(
        labelText: label,
        labelStyle: const TextStyle(fontSize: 11),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        border: const OutlineInputBorder(),
      ),
      style: const TextStyle(fontSize: 13),
      keyboardType: TextInputType.number,
      onSubmitted: (s) async {
        final v = int.tryParse(s);
        if (v != null) await onSubmit(v);
      },
    );
  }

  Widget _selectedPrinterCard(BluetoothPrinterService svc) {
    return Card(
      color: svc.hasPrinter ? const Color(0xFFE8F5E9) : Colors.grey[100],
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Icon(
              svc.hasPrinter ? Icons.print : Icons.print_disabled,
              color: svc.hasPrinter ? _kGreen : Colors.grey,
              size: 32,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    svc.hasPrinter ? 'เครื่องพิมพ์ที่เลือก' : 'ยังไม่ได้เลือก',
                    style: const TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  if (svc.hasPrinter) ...[
                    Text(
                      svc.name ?? '(ไม่มีชื่อ)',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    Text(
                      svc.mac!,
                      style: const TextStyle(fontSize: 11, color: Colors.grey),
                    ),
                    Text(
                      svc.connected ? '🟢 connected' : '⚪ idle',
                      style: const TextStyle(fontSize: 11),
                    ),
                  ],
                ],
              ),
            ),
            if (svc.hasPrinter)
              IconButton(
                icon: const Icon(Icons.delete_outline, color: Colors.red),
                onPressed: () => svc.clearPrinter(),
              ),
          ],
        ),
      ),
    );
  }

  Widget _scannedDevicesSection(BluetoothPrinterService svc) {
    if (_found.isEmpty && !_scanning) {
      return Card(
        color: const Color(0xFFFFF8E1),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            children: [
              const Icon(Icons.bluetooth_searching, size: 40, color: _kOrange),
              const SizedBox(height: 8),
              const Text(
                'ยังไม่พบเครื่อง BLE',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
              ),
              const SizedBox(height: 8),
              const Text(
                'เปิดเครื่องพิมพ์ + กดปุ่ม power ค้างจนไฟกระพริบ\n'
                'แล้วกด "🔍 สแกน BLE" ด้านบน\n\n'
                '💡 BLE printer ไม่ต้อง pair ใน Settings — แค่สแกนแล้วเลือกได้เลย',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12),
              ),
            ],
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 4),
          child: Text(
            'อุปกรณ์ BLE ที่พบ — แตะ "เลือก"',
            style: TextStyle(fontWeight: FontWeight.bold),
          ),
        ),
        ..._found.map((r) {
          final n = r.advertisementData.advName.isNotEmpty
              ? r.advertisementData.advName
              : r.device.platformName;
          final mac = r.device.remoteId.str;
          final isSelected = svc.mac == mac;
          final isPrinter = _isLikelyPrinter(r);
          return Card(
            color: isSelected ? const Color(0xFFE8F5E9) : null,
            child: ListTile(
              leading: Icon(
                isPrinter ? Icons.print : Icons.bluetooth,
                color: isSelected
                    ? _kGreen
                    : (isPrinter ? _kOrange : Colors.blueGrey),
              ),
              title: Row(
                children: [
                  Expanded(
                    child: Text(
                      n.isEmpty ? '(ไม่มีชื่อ)' : n,
                      style: TextStyle(
                        fontWeight: isSelected || isPrinter
                            ? FontWeight.bold
                            : FontWeight.normal,
                      ),
                    ),
                  ),
                  if (isPrinter)
                    const Padding(
                      padding: EdgeInsets.only(left: 4),
                      child: Text('🏷️', style: TextStyle(fontSize: 13)),
                    ),
                ],
              ),
              subtitle: Text(
                '$mac · RSSI ${r.rssi} dBm',
                style: const TextStyle(fontSize: 11),
              ),
              trailing: isSelected
                  ? const Icon(Icons.check_circle, color: _kGreen)
                  : ElevatedButton(
                      onPressed: () => svc.selectPrinter(r),
                      child: const Text('เลือก'),
                    ),
            ),
          );
        }),
      ],
    );
  }

  Widget _instructionsCard() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFE8F4FD),
        borderRadius: BorderRadius.circular(6),
      ),
      child: const Text(
        '💡 หมายเหตุ:\n'
        '• A70Pro / AYIN / IPRT — BLE label printer (Tencent FEE7 service)\n'
        '• Android 12+ ต้องการสิทธิ์ "Nearby devices" — Android 11- ต้องการ Bluetooth + Location\n'
        '\n'
        '📄 ชนิดกระดาษ:\n'
        '• ต่อเนื่อง (continuous) → กระดาษม้วนใบเสร็จ ไม่มี gap, sensor ถูกปิด\n'
        '• ฉลาก gap → ฉลาก die-cut มี gap 2-3mm คั่นระหว่างใบ\n'
        '• Black mark → กระดาษมีแถบดำหลังเป็น marker\n'
        '\n'
        '🧾 ถ้าพิมพ์ออกมาเป็น SIZE / GAP / BITMAP → Protocol ผิด ให้เลือก ESC/POS\n'
        '\n'
        '⚠️ ถ้าเครื่อง alarm/พิมพ์ไม่ออก → ตั้งชนิดกระดาษให้ตรง + กด "Calibrate sensor"',
        style: TextStyle(fontSize: 12, color: Color(0xFF2980B9)),
      ),
    );
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:io' show InternetAddressType, NetworkInterface, Platform;
import 'package:bonsoir/bonsoir.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import '../config.dart';

class SettingsScreen extends StatefulWidget {
  final bool closeOnSave;
  const SettingsScreen({super.key, this.closeOnSave = false});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late TextEditingController _urlCtrl;
  String? _testResult;
  bool _testing = false;

  // mDNS scan state
  BonsoirDiscovery? _discovery;
  StreamSubscription<BonsoirDiscoveryEvent>? _discSub;
  bool _scanning = false;
  String? _scanStatus;
  int _scanRun = 0;
  final List<_DiscoveredServer> _found = [];

  @override
  void initState() {
    super.initState();
    _urlCtrl = TextEditingController(text: AppConfig.apiBase);
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    unawaited(_stopScan(updateUi: false));
    super.dispose();
  }

  Future<void> _save() async {
    await AppConfig.setApiBase(_urlCtrl.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('บันทึก Server URL แล้ว')));
    if (widget.closeOnSave) Navigator.of(context).pop(true);
  }

  Future<void> _resetToDefault() async {
    await AppConfig.setApiBase('');
    setState(() => _urlCtrl.text = AppConfig.compileTimeBase);
  }

  Future<void> _testCurrent() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final url = AppConfig.normalizeBase(_urlCtrl.text);
    if (url != _urlCtrl.text.trim()) {
      _urlCtrl.text = url;
    }
    final client = AppConfig.httpClientFor(url);
    try {
      final res = await client
          .get(
            Uri.parse('$url/api/discovery/info'),
            headers: AppConfig.tunnelHeadersFor(url),
          )
          .timeout(const Duration(seconds: 4));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, dynamic>;
        setState(() {
          _testResult =
              '✅ พบ ${j["name"]} v${j["version"]} '
              '(${(j["addresses"] as List?)?.join(", ") ?? "?"})';
        });
      } else {
        setState(() {
          _testResult = '❌ HTTP ${res.statusCode}';
        });
      }
    } catch (e) {
      setState(() {
        _testResult = '❌ ${_friendlyNetworkError(e, url)}';
      });
    } finally {
      client.close();
      if (mounted) {
        setState(() {
          _testing = false;
        });
      }
    }
  }

  String _friendlyNetworkError(Object e, String url) {
    return AppConfig.friendlyNetworkError(e, url: url);
  }

  bool get _supportsMdns =>
      !kIsWeb &&
      (Platform.isAndroid ||
          Platform.isIOS ||
          Platform.isMacOS ||
          Platform.isWindows);

  Future<bool> _ensureDiscoveryPermission() async {
    if (!Platform.isAndroid) return true;
    final status = await Permission.nearbyWifiDevices.status;
    if (status.isGranted || status.isLimited) return true;
    final requested = await Permission.nearbyWifiDevices.request();
    return requested.isGranted || requested.isLimited;
  }

  Future<void> _startScan() async {
    if (!_supportsMdns) return;
    await _stopScan();
    final run = ++_scanRun;
    setState(() {
      _scanning = true;
      _scanStatus = 'กำลังสแกน mDNS และ LAN subnet ...';
      _found.clear();
    });
    final allowMdns = await _ensureDiscoveryPermission();
    if (!mounted || run != _scanRun) return;
    try {
      if (allowMdns) {
        final disc = BonsoirDiscovery(type: '_pos_v2._tcp');
        await disc.ready;
        await disc.start();
        _discovery = disc;
        _discSub = disc.eventStream?.listen((evt) {
          final svc = evt.service;
          if (svc == null || run != _scanRun) return;
          if (evt.type == BonsoirDiscoveryEventType.discoveryServiceFound) {
            // Some platforms need explicit resolve to fill in host.
            svc.resolve(disc.serviceResolver);
          } else if (evt.type ==
              BonsoirDiscoveryEventType.discoveryServiceResolved) {
            final resolved = svc as ResolvedBonsoirService;
            final host = resolved.host;
            if (host == null) return;
            _addDiscovered(
              _DiscoveredServer(
                name: resolved.name,
                host: host,
                port: resolved.port,
                url: 'http://$host:${resolved.port}',
              ),
            );
          } else if (evt.type ==
              BonsoirDiscoveryEventType.discoveryServiceLost) {
            setState(() => _found.removeWhere((e) => e.name == svc.name));
          }
        });
      } else {
        setState(() {
          _scanStatus =
              'Android ยังไม่อนุญาต Nearby Wi-Fi; กำลังใช้ HTTP scan แทน';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _scanStatus = 'mDNS ใช้ไม่ได้ ($e); กำลังใช้ HTTP scan แทน';
        });
      }
    }
    unawaited(_scanLanHttp(run));
  }

  Future<void> _stopScan({bool updateUi = true}) async {
    _scanRun++;
    await _discSub?.cancel();
    _discSub = null;
    try {
      await _discovery?.stop();
    } catch (_) {}
    _discovery = null;
    if (updateUi && mounted) {
      setState(() {
        _scanning = false;
        _scanStatus = null;
      });
    }
  }

  Future<void> _useDiscovered(_DiscoveredServer s) async {
    setState(() => _urlCtrl.text = s.url);
    await AppConfig.setApiBase(s.url);
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('บันทึก Server: ${s.url}')));
    if (widget.closeOnSave) {
      Navigator.of(context).pop(true);
      return;
    }
    await _testCurrent();
  }

  void _addDiscovered(_DiscoveredServer entry) {
    if (!mounted) return;
    if (_found.any((e) => e.url == entry.url)) return;
    setState(() {
      _found.add(entry);
      _scanStatus = 'พบ ${_found.length} server';
    });
  }

  Future<void> _scanLanHttp(int run) async {
    final prefixes = await _localSubnetPrefixes();
    if (!mounted || run != _scanRun) return;
    if (prefixes.isEmpty) {
      setState(() {
        _scanStatus =
            'ไม่พบ IP ของ Wi-Fi ในเครื่องนี้ กรุณากรอก URL server เอง';
      });
      return;
    }

    final client = http.Client();
    try {
      for (final prefix in prefixes) {
        if (run != _scanRun) return;
        setState(() => _scanStatus = 'กำลังค้นหา http://$prefix.x:4000 ...');
        for (var start = 1; start <= 254; start += 32) {
          if (run != _scanRun) return;
          final end = (start + 31).clamp(1, 254);
          await Future.wait([
            for (var host = start; host <= end; host++)
              _probeHttpServer(client, 'http://$prefix.$host:4000', run),
          ]);
          if (_found.isNotEmpty) return;
        }
      }
      if (mounted && run == _scanRun && _found.isEmpty) {
        setState(() {
          _scanStatus =
              'ยังไม่พบ server: ตรวจ Wi-Fi เดียวกัน, firewall 4000, หรือกรอก IP เครื่องหลักเอง';
        });
      }
    } finally {
      client.close();
    }
  }

  Future<void> _probeHttpServer(http.Client client, String url, int run) async {
    try {
      final res = await client
          .get(Uri.parse('$url/api/discovery/info'))
          .timeout(const Duration(milliseconds: 700));
      if (run != _scanRun || res.statusCode != 200) return;
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is! Map<String, dynamic> || body['service'] != 'pos_v2') {
        return;
      }
      final uri = Uri.parse(url);
      _addDiscovered(
        _DiscoveredServer(
          name: body['name']?.toString() ?? 'POS V2 Server',
          host: uri.host,
          port: uri.port,
          url: url,
        ),
      );
    } catch (_) {
      // Keep LAN scan quiet; most hosts in the subnet will not be POS servers.
    }
  }

  Future<List<String>> _localSubnetPrefixes() async {
    final prefixes = <String>{};
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      ).timeout(const Duration(seconds: 2));
      for (final iface in interfaces) {
        for (final address in iface.addresses) {
          final ip = address.address;
          if (!_isPrivateIpv4(ip)) continue;
          final parts = ip.split('.');
          prefixes.add('${parts[0]}.${parts[1]}.${parts[2]}');
        }
      }
    } catch (_) {}

    if (prefixes.isEmpty) {
      prefixes.addAll(['192.168.1', '192.168.0']);
    }
    return prefixes.toList();
  }

  bool _isPrivateIpv4(String ip) {
    final parts = ip.split('.').map(int.tryParse).toList();
    if (parts.length != 4 || parts.any((p) => p == null)) return false;
    final a = parts[0]!;
    final b = parts[1]!;
    if (a == 10) return true;
    if (a == 192 && b == 168) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('ตั้งค่า — Server'),
        backgroundColor: const Color(0xFF1A1A2E),
        foregroundColor: Colors.white,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Backend URL',
            style: TextStyle(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 6),
          TextField(
            controller: _urlCtrl,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              hintText:
                  'http://192.168.1.10:4000 หรือ https://xxxxx.ngrok-free.dev',
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: _testing ? null : _testCurrent,
                  icon: _testing
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.network_check),
                  label: const Text('ทดสอบ'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: _save,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF1A1A2E),
                    foregroundColor: Colors.white,
                  ),
                  icon: const Icon(Icons.save),
                  label: const Text('บันทึก'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (_testResult != null)
            Container(
              padding: const EdgeInsets.all(10),
              color: const Color(0xFFF0F0F5),
              child: Text(_testResult!),
            ),
          const SizedBox(height: 16),
          const Divider(),
          const SizedBox(height: 8),
          const Text(
            'สแกน Server บน LAN',
            style: TextStyle(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 4),
          const Text(
            'ถ้าใช้งานนอกวง LAN ให้กรอก Public URL/ngrok แล้วกดทดสอบ',
            style: TextStyle(fontSize: 12, color: Colors.grey),
          ),
          const SizedBox(height: 6),
          if (!_supportsMdns)
            const Text(
              'แพลตฟอร์มนี้ไม่รองรับ mDNS — ใช้พิมพ์ URL เองและกดทดสอบ',
              style: TextStyle(color: Colors.grey),
            )
          else
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _scanning ? _stopScan : _startScan,
                    icon: Icon(_scanning ? Icons.stop : Icons.search),
                    label: Text(_scanning ? 'หยุดสแกน' : 'สแกน LAN'),
                  ),
                ),
              ],
            ),
          const SizedBox(height: 8),
          if (_scanning && _found.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _scanStatus ?? 'กำลังสแกน mDNS และ LAN subnet ...',
                    ),
                  ),
                ],
              ),
            ),
          if (!_scanning && _scanStatus != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(_scanStatus!, style: const TextStyle(fontSize: 12)),
            ),
          ..._found.map(
            (s) => Card(
              child: ListTile(
                leading: const Icon(Icons.dns, color: Color(0xFF1A1A2E)),
                title: Text(s.name),
                subtitle: Text(s.url),
                trailing: ElevatedButton(
                  onPressed: () => _useDiscovered(s),
                  child: const Text('ใช้'),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: _resetToDefault,
            icon: const Icon(Icons.restore),
            label: const Text('Reset เป็นค่า default'),
          ),
        ],
      ),
    );
  }
}

class _DiscoveredServer {
  final String name;
  final String host;
  final int port;
  final String url;
  _DiscoveredServer({
    required this.name,
    required this.host,
    required this.port,
    required this.url,
  });
}

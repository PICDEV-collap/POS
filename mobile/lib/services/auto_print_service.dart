import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_service.dart';
import 'auth_service.dart';
import 'bluetooth_printer_service.dart';
import 'socket_service.dart';

/// Listens to `order:new` socket events and — when the user has a paired BLE
/// printer AND the corresponding auto-print toggle is on — fetches the
/// rendered ESC/POS / TSPL bytes from the backend and streams them to the
/// printer.
///
/// The dedup set prevents accidentally printing the same order twice when
/// the socket reconnects mid-session.
class AutoPrintService {
  static const _kPendingJobs = 'auto_print_pending_jobs_v1';
  static const _kPrintedJobs = 'auto_print_printed_jobs_v1';
  static const _kPendingTtlMs = 2 * 60 * 60 * 1000;
  static const _kPrintedTtlMs = 24 * 60 * 60 * 1000;
  static const _kPrinterWarmupMs = 250;
  static const _kAutoPrintCooldownMs = 1200;

  final ApiService api;
  final AuthService auth;
  final SocketService socket;
  final BluetoothPrinterService printer;

  bool _wired = false;
  bool _restored = false;
  bool _draining = false;
  Timer? _retryTimer;
  final Map<String, _AutoPrintJob> _pending = {};
  final Set<String> _printed = {};
  final Map<String, int> _printedAt = {};

  AutoPrintService({
    required this.api,
    required this.auth,
    required this.socket,
    required this.printer,
  });

  /// Wire the listener — safe to call multiple times.
  void start() {
    if (!_wired) {
      _wired = true;
      socket.on('order:new', _onOrderEvent);
    }
    unawaited(_restorePending());
    if (printer.hasPrinter && printer.autoPrintKitchen) {
      unawaited(printer.warmUp());
    }
    kick();
  }

  void resume() {
    start();
    if (printer.hasPrinter && printer.autoPrintKitchen) {
      unawaited(printer.warmUp());
    }
    kick();
  }

  void _onOrderEvent(dynamic data) {
    if (data is! Map) return;
    final id = (data['id'] is int)
        ? data['id'] as int
        : int.tryParse('${data['id']}');
    if (id == null) return;
    // Don't auto-print someone else's session by accident — staff/kitchen
    // tokens are scoped, but the socket is shared, so we still gate on
    // logged-in AND printer-paired AND opted-in.
    if (!auth.isLoggedIn) return;
    if (!printer.hasPrinter) return;
    if (printer.autoPrintKitchen) _enqueue(id, 'kitchen');
  }

  void kick() {
    _retryTimer?.cancel();
    unawaited(_drain());
  }

  void _enqueue(int orderId, String type) {
    final key = _AutoPrintJob.keyFor(orderId, type);
    if (_printed.contains(key) || _pending.containsKey(key)) return;
    _pending[key] = _AutoPrintJob(orderId: orderId, type: type);
    _log('queued', {'job': key, 'pending': _pending.length});
    unawaited(_persistPending());
    kick();
  }

  Future<void> _drain() async {
    if (_draining) return;
    await _restorePending();
    if (_pending.isEmpty) return;
    if (!auth.isLoggedIn || !printer.hasPrinter) {
      _scheduleRetry(const Duration(seconds: 5));
      return;
    }

    _draining = true;
    try {
      while (_pending.isNotEmpty) {
        final now = DateTime.now().millisecondsSinceEpoch;
        final job = _nextReadyJob(now);
        if (job == null) {
          _scheduleNextPending(now);
          break;
        }

        if (!_isEnabled(job.type)) {
          _pending.remove(job.key);
          _log('cancelled disabled job', {'job': job.key});
          await _persistPending();
          continue;
        }

        final ok = await _print(job);
        if (!ok) break;
      }
    } finally {
      _draining = false;
    }
  }

  Future<bool> _print(_AutoPrintJob job) async {
    int? claimId;
    try {
      _log('printing', {'job': job.key, 'attempt': job.attempts + 1});
      final claim = await api.claimMobilePrint(job.orderId, job.type);
      if (claim['claimed'] != true) {
        _pending.remove(job.key);
        _rememberPrinted(job.key);
        _log('skipped claimed elsewhere', {
          'job': job.key,
          'reason': claim['reason'] ?? 'already_claimed',
          'claim_id': claim['id'],
        });
        await _persistPending();
        await _persistPrinted();
        return true;
      }
      claimId = int.tryParse('${claim['id']}');
      final ready = await printer.warmUp();
      if (!ready) {
        throw Exception(printer.lastError ?? 'printer not ready');
      }
      await Future.delayed(const Duration(milliseconds: _kPrinterWarmupMs));
      final protocol = printer.autoProtocol;
      final renderMode = printer.autoRenderMode;
      final payload = await api.getPrintPayload(
        job.orderId,
        job.type,
        widthPx: printer.widthPx,
        widthChars: printer.widthChars,
        renderMode: renderMode,
        protocol: protocol,
        labelWidthMm: printer.labelWidthMm,
        labelHeightMm: printer.autoLabelHeightMm,
        gapMm: printer.autoGapMm,
        blineMm: printer.autoBlineMm,
        paperType: printer.autoPaperType,
      );
      _log('payload ready', {
        'job': job.key,
        'bytes': payload['bytes_length'],
        'protocol': payload['protocol'] ?? protocol,
        'render_mode': payload['render_mode'] ?? renderMode,
        'paper_type': payload['paper_type'] ?? printer.autoPaperType,
      });
      final ok = await printer.printBase64(payload['bytes_base64'] as String);
      if (ok) {
        if (claimId != null) {
          try {
            await api.completeMobilePrintClaim(claimId, ok: true);
          } catch (e) {
            _log('claim complete failed after print accepted', {
              'job': job.key,
              'claim_id': claimId,
              'error': e.toString(),
            });
          }
        }
        _pending.remove(job.key);
        _rememberPrinted(job.key);
        _log('success', {
          'job': job.key,
          'bytes': payload['bytes_length'],
          'pending': _pending.length,
        });
        await _persistPending();
        await _persistPrinted();
        if (_pending.isNotEmpty) {
          await Future.delayed(
            const Duration(milliseconds: _kAutoPrintCooldownMs),
          );
        }
        return true;
      }
      if (claimId != null) {
        await api.completeMobilePrintClaim(
          claimId,
          ok: false,
          error: printer.lastError ?? 'unknown printer error',
        );
      }
      _markRetry(job, printer.lastError ?? 'unknown printer error');
      await _persistPending();
      return false;
    } catch (e) {
      if (claimId != null) {
        try {
          await api.completeMobilePrintClaim(
            claimId,
            ok: false,
            error: e.toString(),
          );
        } catch (_) {}
      }
      _markRetry(job, e.toString());
      await _persistPending();
      return false;
    }
  }

  void dispose() {
    socket.off('order:new', _onOrderEvent);
    _retryTimer?.cancel();
    _wired = false;
  }

  _AutoPrintJob? _nextReadyJob(int now) {
    final jobs = _pending.values.where((job) => job.nextAt <= now).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return jobs.isEmpty ? null : jobs.first;
  }

  bool _isEnabled(String type) {
    return type == 'kitchen'
        ? printer.autoPrintKitchen
        : false;
  }

  void _markRetry(_AutoPrintJob job, String error) {
    job.attempts += 1;
    job.lastError = error;
    final backoffSeconds = (2 << (job.attempts - 1)).clamp(2, 60);
    job.nextAt = DateTime.now().millisecondsSinceEpoch + backoffSeconds * 1000;
    _log('retry scheduled', {
      'job': job.key,
      'attempt': job.attempts,
      'backoff_seconds': backoffSeconds,
      'error': error,
    });
    _scheduleRetry(Duration(seconds: backoffSeconds));
  }

  void _scheduleNextPending(int now) {
    final nextAt = _pending.values
        .map((job) => job.nextAt)
        .fold<int?>(
          null,
          (min, value) => min == null || value < min ? value : min,
        );
    if (nextAt == null) return;
    final delayMs = (nextAt - now).clamp(1000, 60000);
    _scheduleRetry(Duration(milliseconds: delayMs));
  }

  void _scheduleRetry(Duration delay) {
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, kick);
  }

  Future<void> _restorePending() async {
    if (_restored) return;
    _restored = true;
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_kPendingJobs);
      if (raw != null && raw.isNotEmpty) {
        final now = DateTime.now().millisecondsSinceEpoch;
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          for (final item in decoded) {
            if (item is! Map) continue;
            final job = _AutoPrintJob.fromJson(Map<String, dynamic>.from(item));
            if (now - job.createdAt > _kPendingTtlMs) {
              _log('dropped stale pending job', {'job': job.key});
              continue;
            }
            _pending[job.key] = job;
          }
        }
      }
      await _restorePrinted(p);
      if (_pending.isNotEmpty) {
        _log('restored pending jobs', {'pending': _pending.length});
      }
    } catch (e) {
      _log('restore failed', {'error': e.toString()});
    }
  }

  Future<void> _restorePrinted(SharedPreferences p) async {
    final raw = p.getString(_kPrintedJobs);
    if (raw == null || raw.isEmpty) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final decoded = jsonDecode(raw);
    if (decoded is! Map) return;
    for (final entry in decoded.entries) {
      final key = entry.key.toString();
      final ts = int.tryParse(entry.value.toString()) ?? 0;
      if (ts > 0 && now - ts <= _kPrintedTtlMs) {
        _printed.add(key);
        _printedAt[key] = ts;
      }
    }
    if (_printed.isNotEmpty) {
      _log('restored printed dedupe', {'printed': _printed.length});
    }
    await _persistPrinted();
  }

  Future<void> _persistPending() async {
    final p = await SharedPreferences.getInstance();
    final items = _pending.values.map((job) => job.toJson()).toList();
    await p.setString(_kPendingJobs, jsonEncode(items));
  }

  void _rememberPrinted(String key) {
    final now = DateTime.now().millisecondsSinceEpoch;
    _printed.add(key);
    _printedAt[key] = now;
  }

  Future<void> _persistPrinted() async {
    final p = await SharedPreferences.getInstance();
    final now = DateTime.now().millisecondsSinceEpoch;
    _printedAt.removeWhere((_, ts) => now - ts > _kPrintedTtlMs);
    _printed
      ..clear()
      ..addAll(_printedAt.keys);
    await p.setString(_kPrintedJobs, jsonEncode(_printedAt));
  }

  void _log(String message, [Map<String, Object?>? meta]) {
    debugPrint(
      '[auto-print] $message${meta == null ? '' : ' ${jsonEncode(meta)}'}',
    );
  }
}

class _AutoPrintJob {
  final int orderId;
  final String type;
  final int createdAt;
  int attempts;
  int nextAt;
  String? lastError;

  _AutoPrintJob({
    required this.orderId,
    required this.type,
    int? createdAt,
    this.attempts = 0,
    int? nextAt,
    this.lastError,
  }) : createdAt = createdAt ?? DateTime.now().millisecondsSinceEpoch,
       nextAt = nextAt ?? 0;

  String get key => keyFor(orderId, type);

  static String keyFor(int orderId, String type) => '$type:$orderId';

  factory _AutoPrintJob.fromJson(Map<String, dynamic> json) {
    return _AutoPrintJob(
      orderId: int.parse(json['order_id'].toString()),
      type: json['type']?.toString() == 'receipt' ? 'receipt' : 'kitchen',
      createdAt: int.tryParse(json['created_at']?.toString() ?? ''),
      attempts: int.tryParse(json['attempts']?.toString() ?? '') ?? 0,
      nextAt: int.tryParse(json['next_at']?.toString() ?? '') ?? 0,
      lastError: json['last_error']?.toString(),
    );
  }

  Map<String, dynamic> toJson() => {
    'order_id': orderId,
    'type': type,
    'created_at': createdAt,
    'attempts': attempts,
    'next_at': nextAt,
    if (lastError != null) 'last_error': lastError,
  };
}

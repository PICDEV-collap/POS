import 'dart:async';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'auth_service.dart';
import 'socket_service.dart';

/// Plays a spoken Thai notification when an order arrives ("รับออเดอร์") or is
/// paid ("ขอบคุณครับ"). Mirrors the web `useOrderSounds` hook: same bundled
/// clips, same freshness/dedup/store filtering so replayed or other-store
/// events don't ring. Wired once per session like [AutoPrintService.start].
class SoundService extends ChangeNotifier {
  static const _kEnabled = 'pos_sound_enabled_v1';
  // Ignore socket events older than this — the realtime layer replays missed
  // events after reconnect, and stale replays must not re-announce.
  static const _freshWindowMs = 3 * 60 * 1000;

  static const _clipNewOrder = 'sounds/new-order.mp3';
  static const _clipPayment = 'sounds/payment.mp3';
  static const _clipCall = 'sounds/call-staff.mp3';

  final AuthService auth;
  final SocketService socket;

  final AudioPlayer _player = AudioPlayer();
  bool _enabled = true;
  bool _wired = false;
  final Set<int> _seenNew = <int>{};
  final Set<int> _seenPaid = <int>{};

  SoundService({required this.auth, required this.socket});

  bool get enabled => _enabled;

  Future<void> bootstrap() async {
    final p = await SharedPreferences.getInstance();
    _enabled = p.getBool(_kEnabled) ?? true;
    notifyListeners();
  }

  Future<void> setEnabled(bool value) async {
    _enabled = value;
    notifyListeners();
    final p = await SharedPreferences.getInstance();
    await p.setBool(_kEnabled, value);
    // Turning it on previews the new-order phrase — confirms audio works.
    if (value) unawaited(playNewOrder());
  }

  void toggle() => unawaited(setEnabled(!_enabled));

  /// Subscribe to order events. Idempotent — safe to call on every login.
  void start() {
    if (_wired) return;
    _wired = true;
    socket.on('order:new', _onNew);
    socket.on('order:update', _onUpdate);
  }

  @override
  void dispose() {
    socket.off('order:new', _onNew);
    socket.off('order:update', _onUpdate);
    _player.dispose();
    _wired = false;
    super.dispose();
  }

  void _onNew(dynamic data) {
    if (!_enabled || !auth.isLoggedIn || data is! Map) return;
    final id = int.tryParse('${data['id']}');
    if (id == null || _seenNew.contains(id)) return;
    if (!_storeMatches(data) || !_fresh(data['created_at'])) return;
    _remember(_seenNew, id);
    unawaited(playNewOrder());
  }

  void _onUpdate(dynamic data) {
    if (!_enabled || !auth.isLoggedIn || data is! Map) return;
    if (data['status'] != 'paid') return;
    final id = int.tryParse('${data['id']}');
    if (id == null || _seenPaid.contains(id)) return;
    if (!_storeMatches(data) || !_fresh(data['updated_at'] ?? data['created_at'])) {
      return;
    }
    _remember(_seenPaid, id);
    unawaited(playPayment());
  }

  bool _storeMatches(Map data) {
    final want = auth.activeStoreId;
    if (want == null) return true;
    final got = int.tryParse('${data['store_id']}');
    return got == null || got == want;
  }

  bool _fresh(dynamic iso) {
    if (iso == null) return true;
    final t = DateTime.tryParse(iso.toString());
    if (t == null) return true;
    return DateTime.now().difference(t).inMilliseconds < _freshWindowMs;
  }

  void _remember(Set<int> set, int id) {
    set.add(id);
    if (set.length > 300) set.remove(set.first);
  }

  Future<void> playNewOrder() => _play(_clipNewOrder);
  Future<void> playPayment() => _play(_clipPayment);

  /// Customer "call staff / request bill". Called by the staff screen (not
  /// wired globally, so kitchen/admin don't ring for bill calls — matches web).
  Future<void> playCall() => _play(_clipCall);

  Future<void> _play(String asset) async {
    if (!_enabled) return;
    try {
      await _player.stop();
      await _player.play(AssetSource(asset));
    } catch (e) {
      debugPrint('[sound] play failed: $e');
    }
  }
}

/// App-bar toggle for the notification voice — parity with the web pill button.
class SoundToggleButton extends StatelessWidget {
  const SoundToggleButton({super.key, this.color});

  final Color? color;

  @override
  Widget build(BuildContext context) {
    final enabled = context.watch<SoundService>().enabled;
    return IconButton(
      tooltip: enabled ? 'ปิดเสียงแจ้งเตือน' : 'เปิดเสียงแจ้งเตือน',
      onPressed: () => context.read<SoundService>().toggle(),
      icon: Icon(enabled ? Icons.volume_up : Icons.volume_off, color: color),
    );
  }
}

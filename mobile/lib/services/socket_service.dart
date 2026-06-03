import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;
import '../config.dart';

class SocketService extends ChangeNotifier {
  static const _kClientId = 'socket_client_id_v1';
  static const _kLastEventId = 'socket_last_event_id_v1';

  io.Socket? _socket;
  bool _connected = false;
  Timer? _heartbeat;
  String _clientId = '';
  final Set<int> _seenEventIds = <int>{};
  final Map<String, List<void Function(dynamic)>> _handlers = {};
  final Map<String, void Function(dynamic)> _legacyDispatchers = {};
  final Map<String, int> _recentDispatches = {};
  int _lastEventId = 0;

  bool get connected => _connected;
  int get lastEventId => _lastEventId;

  Future<void> bootstrap() async {
    final p = await SharedPreferences.getInstance();
    _clientId =
        p.getString(_kClientId) ??
        'mobile-${DateTime.now().millisecondsSinceEpoch}';
    _lastEventId = p.getInt(_kLastEventId) ?? 0;
    await p.setString(_kClientId, _clientId);
  }

  void connect() {
    if (_clientId.isEmpty) {
      _clientId = 'mobile-${DateTime.now().millisecondsSinceEpoch}';
    }
    if (_socket != null) {
      if (_socket?.connected == true) {
        if (!_connected) {
          _connected = true;
          notifyListeners();
        }
        _requestReplay();
      } else {
        _socket?.connect();
      }
      return;
    }
    final transports = AppConfig.isNgrokFreeBase
        ? ['polling', 'websocket']
        : ['websocket', 'polling'];
    _socket = io.io(
      AppConfig.apiBase,
      io.OptionBuilder()
          .setTransports(transports)
          .enableAutoConnect()
          .enableReconnection()
          .setReconnectionAttempts(999999)
          .setReconnectionDelay(400)
          .setReconnectionDelayMax(2500)
          .setTimeout(3000)
          .setAuth({'client_id': _clientId, 'last_event_id': _lastEventId})
          .setExtraHeaders(AppConfig.tunnelHeaders)
          .build(),
    );
    _installLegacyDispatchers();
    _socket!.onConnect((_) {
      _connected = true;
      _requestReplay();
      _heartbeat ??= Timer.periodic(const Duration(seconds: 10), (_) {
        if (_socket?.connected == true) {
          _socket?.emitWithAck('heartbeat', {
            'ts': DateTime.now().millisecondsSinceEpoch,
          }, ack: (_) {});
        }
      });
      notifyListeners();
    });
    _socket!.onDisconnect((_) {
      _connected = false;
      _heartbeat?.cancel();
      _heartbeat = null;
      notifyListeners();
    });
    _socket!.onConnectError((err) async {
      if (!AppConfig.isHandshakeError(err)) return;
      final repaired = await AppConfig.repairBaseAfterHandshake();
      if (!repaired || _socket == null) return;
      _heartbeat?.cancel();
      _heartbeat = null;
      _socket?.dispose();
      _socket = null;
      _legacyDispatchers.clear();
      _connected = false;
      notifyListeners();
      connect();
    });
    _socket!.on('realtime:event', (payload) {
      if (payload is! Map) return;
      final id = int.tryParse(payload['id']?.toString() ?? '');
      if (id != null) {
        if (_seenEventIds.contains(id)) {
          _socket?.emit('realtime:ack', {'event_id': id});
          return;
        }
        _seenEventIds.add(id);
        if (_seenEventIds.length > 500) {
          _seenEventIds.remove(_seenEventIds.first);
        }
        if (id > _lastEventId) {
          _lastEventId = id;
          unawaited(_persistLastEventId(id));
        }
      }
      // Dispatch both live envelopes and replay envelopes. The backend emits
      // realtime:event before the legacy direct event; if Android suspends the
      // app in that small window, relying only on the direct event drops prints.
      if (payload['event'] != null) {
        final event = payload['event'].toString();
        _dispatchDeduped(event, payload['payload'], source: 'realtime');
      }
      if (id != null) _socket?.emit('realtime:ack', {'event_id': id});
    });
  }

  void on(String event, void Function(dynamic) handler) {
    _handlers.putIfAbsent(event, () => []).add(handler);
    _ensureLegacyDispatcher(event);
  }

  void off(String event, [void Function(dynamic)? handler]) {
    if (handler == null) {
      _handlers.remove(event);
    } else {
      _handlers[event]?.remove(handler);
      if (_handlers[event]?.isEmpty == true) _handlers.remove(event);
    }
    if (!_handlers.containsKey(event)) {
      final dispatcher = _legacyDispatchers.remove(event);
      if (dispatcher != null) _socket?.off(event, dispatcher);
    }
  }

  void resume() {
    final current = _socket;
    connect();
    if (_socket?.connected == true) {
      _requestReplay();
      return;
    }
    // Android can resume with a stale socket object after screen sleep/WiFi
    // roaming: neither connected nor cleanly disconnected. If connect() does
    // not recover quickly, rebuild the socket so role screens do not stay
    // stuck in "offline - cache" until the user presses refresh.
    Timer(const Duration(seconds: 2), () {
      if (_socket == null || _socket?.connected == true || _socket != current) {
        return;
      }
      _heartbeat?.cancel();
      _heartbeat = null;
      _socket?.dispose();
      _socket = null;
      _legacyDispatchers.clear();
      _connected = false;
      notifyListeners();
      connect();
    });
  }

  void disconnect() {
    _heartbeat?.cancel();
    _heartbeat = null;
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
    _legacyDispatchers.clear();
    _connected = false;
    notifyListeners();
  }

  void _installLegacyDispatchers() {
    for (final event in _handlers.keys) {
      _ensureLegacyDispatcher(event);
    }
  }

  void _ensureLegacyDispatcher(String event) {
    if (_socket == null || _legacyDispatchers.containsKey(event)) return;
    void dispatcher(dynamic payload) {
      _dispatchDeduped(event, payload, source: 'legacy');
    }

    _legacyDispatchers[event] = dispatcher;
    _socket!.on(event, dispatcher);
  }

  void _dispatchDeduped(
    String event,
    dynamic payload, {
    required String source,
  }) {
    final key = _dedupeKey(event, payload);
    if (key != null) {
      final now = DateTime.now().millisecondsSinceEpoch;
      _recentDispatches.removeWhere((_, ts) => now - ts > 10000);
      final last = _recentDispatches[key];
      if (last != null && now - last < 3000) {
        debugPrint(
          '[socket] duplicate skipped event=$event source=$source key=$key',
        );
        return;
      }
      _recentDispatches[key] = now;
    }
    _dispatch(event, payload);
  }

  String? _dedupeKey(String event, dynamic payload) {
    if (payload is! Map) return null;
    final id = payload['id'] ?? payload['order_id'];
    if (id == null) return null;
    if (event == 'order:update') {
      return '$event:$id:${payload['status']}:${payload['updated_at']}';
    }
    if (event == 'product:availability') {
      // Include the new value — without it, toggling a product multiple
      // times within 3 s collapses to one "dispatch" and later toggles
      // never reach handlers (mobile stays out of sync with web/admin).
      return '$event:$id:${payload['is_available']}';
    }
    return '$event:$id';
  }

  void _dispatch(String event, dynamic payload) {
    for (final handler in List<void Function(dynamic)>.from(
      _handlers[event] ?? const [],
    )) {
      try {
        handler(payload);
      } catch (e) {
        debugPrint('[socket] handler error event=$event error=$e');
      }
    }
  }

  void _requestReplay() {
    if (_socket?.connected != true) return;
    _socket?.emitWithAck('realtime:resume', {
      'last_event_id': _lastEventId,
    }, ack: (_) {});
  }

  Future<void> _persistLastEventId(int id) async {
    final p = await SharedPreferences.getInstance();
    final current = p.getInt(_kLastEventId) ?? 0;
    if (id > current) await p.setInt(_kLastEventId, id);
  }
}

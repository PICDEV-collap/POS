import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import '../db/database.dart';
import '../models/order.dart';
import 'api_service.dart';

/// Local cache + offline action queue.
///
/// - Calls to [refreshOrders] hit the API; on success they update the local
///   cache; on failure the cache is returned unchanged.
/// - State-changing actions (status updates) go through [updateOrderStatus]
///   which tries the API first; if that fails, the action is queued and
///   the cache is updated optimistically.
/// - [flushPending] drains the queue back to the API.
class OfflineRepository extends ChangeNotifier {
  final ApiService api;
  final AppDatabase db;

  bool _online = true;
  DateTime? _lastSyncAt;
  int _pendingCount = 0;

  bool get online => _online;
  DateTime? get lastSyncAt => _lastSyncAt;
  int get pendingCount => _pendingCount;

  OfflineRepository({required this.api, required this.db});

  // ─── Caching ──────────────────────────────────────────────────────────
  Future<void> _writeCache(List<PosOrder> orders) async {
    await db.transaction(() async {
      // Replace cache wholesale — orders that have moved to 'paid'/'cancelled'
      // stay in the API list briefly, so we trust the latest API list.
      await db.delete(db.cachedOrders).go();
      for (final o in orders) {
        await db
            .into(db.cachedOrders)
            .insert(
              CachedOrdersCompanion.insert(
                id: Value(o.id),
                tableId: o.tableId,
                tableCode: o.tableCode,
                tableLabel: o.tableName,
                status: o.status,
                totalAmount: o.totalAmount,
                note: Value(o.note),
                source: o.source,
                createdAt: o.createdAt,
                itemsJson: jsonEncode(o.items.map(_itemToJson).toList()),
              ),
            );
      }
    });
  }

  Future<List<PosOrder>> _readCache() async {
    final rows = await db.select(db.cachedOrders).get();
    return rows.map(_orderFromCache).toList();
  }

  PosOrder _orderFromCache(CachedOrder r) {
    final items = (jsonDecode(r.itemsJson) as List)
        .map((j) => OrderItem.fromJson(j as Map<String, dynamic>))
        .toList();
    return PosOrder(
      id: r.id,
      dailySeq: r.id,
      tableId: r.tableId,
      tableCode: r.tableCode,
      tableName: r.tableLabel,
      status: r.status,
      totalAmount: r.totalAmount,
      note: r.note,
      source: r.source,
      createdAt: r.createdAt,
      items: items,
    );
  }

  Map<String, dynamic> _itemToJson(OrderItem it) => {
    'id': it.id,
    'product_id': it.productId,
    'product_name': it.productName,
    'unit_price': it.unitPrice,
    'quantity': it.quantity,
    'note': it.note,
    'variant_name': it.variantName,
    'fulfillment_type': it.fulfillmentType,
    'options_selected': it.optionsSelected.map((o) => o.toJson()).toList(),
    'status': it.status,
  };

  // ─── Public read API (cache-first with API refresh) ────────────────────
  /// Hit the API. On success, refresh cache and return fresh data.
  /// On failure, return whatever's cached (possibly empty).
  Future<List<PosOrder>> refreshOrders() async {
    try {
      final list = await api.listOrders();
      await _writeCache(list);
      _online = true;
      _lastSyncAt = DateTime.now();
      await _refreshPendingCount();
      // If we have queued actions, try to flush them now that we know we're online.
      // Fire-and-forget — UI will refresh when each one settles.
      // ignore: unawaited_futures
      flushPending();
      notifyListeners();
      return list;
    } catch (e) {
      _online = false;
      notifyListeners();
      return await _readCache();
    }
  }

  Future<List<PosOrder>> loadCached() => _readCache();

  // ─── Mutations ────────────────────────────────────────────────────────
  /// Try the live API; on failure queue the action and update cache locally.
  Future<void> updateOrderStatus(int id, String status) async {
    try {
      final updated = await api.updateOrderStatus(id, status);
      // Refresh cache row from server response
      await db
          .update(db.cachedOrders)
          .replace(
            CachedOrdersCompanion(
              id: Value(updated.id),
              tableId: Value(updated.tableId),
              tableCode: Value(updated.tableCode),
              tableLabel: Value(updated.tableName),
              status: Value(updated.status),
              totalAmount: Value(updated.totalAmount),
              note: Value(updated.note),
              source: Value(updated.source),
              createdAt: Value(updated.createdAt),
              itemsJson: Value(
                jsonEncode(updated.items.map(_itemToJson).toList()),
              ),
            ),
          );
      _online = true;
      _lastSyncAt = DateTime.now();
      notifyListeners();
    } catch (e) {
      // Queue + optimistic cache update
      await db
          .into(db.pendingActions)
          .insert(
            PendingActionsCompanion.insert(
              actionType: 'order_status',
              targetId: id,
              payloadJson: jsonEncode({'status': status}),
            ),
          );
      await (db.update(db.cachedOrders)..where((t) => t.id.equals(id))).write(
        CachedOrdersCompanion(status: Value(status)),
      );
      _online = false;
      await _refreshPendingCount();
      notifyListeners();
    }
  }

  // ─── Sync queue ───────────────────────────────────────────────────────
  Future<void> flushPending() async {
    final due =
        await (db.select(db.pendingActions)
              ..where(
                (t) => t.nextAttemptAt.isSmallerOrEqualValue(DateTime.now()),
              )
              ..orderBy([(t) => OrderingTerm.asc(t.id)]))
            .get();

    for (final p in due) {
      try {
        if (p.actionType == 'order_status') {
          final payload = jsonDecode(p.payloadJson) as Map<String, dynamic>;
          await api.updateOrderStatus(p.targetId, payload['status'] as String);
        }
        // success → drop it
        await (db.delete(
          db.pendingActions,
        )..where((t) => t.id.equals(p.id))).go();
      } catch (e) {
        // bump attempts + linear backoff (5s, 10s, 15s)
        final attempts = p.attempts + 1;
        await (db.update(
          db.pendingActions,
        )..where((t) => t.id.equals(p.id))).write(
          PendingActionsCompanion(
            attempts: Value(attempts),
            lastError: Value(e.toString()),
            nextAttemptAt: Value(
              DateTime.now().add(Duration(seconds: 5 * attempts)),
            ),
          ),
        );
        if (attempts >= 5) {
          // give up after 5 tries — leave in queue with last error so user can see
        }
      }
    }
    _refreshPendingCount();
    notifyListeners();
  }

  Future<void> _refreshPendingCount() async {
    final rows = await db.select(db.pendingActions).get();
    _pendingCount = rows.length;
  }

  Future<List<PendingAction>> listPending() {
    return (db.select(
      db.pendingActions,
    )..orderBy([(t) => OrderingTerm.asc(t.id)])).get();
  }
}

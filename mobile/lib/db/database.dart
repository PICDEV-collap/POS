// Local SQLite (drift) — caches orders + queues offline actions.
// Cross-platform via drift_flutter (NativeDatabase / WebDatabase auto-pick).

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'database.g.dart';

@DataClassName('CachedOrder')
class CachedOrders extends Table {
  IntColumn get id => integer()();
  IntColumn get tableId => integer()();
  TextColumn get tableCode => text()();
  // Avoid shadowing drift's `Table.tableName`; map SQL column `table_label`
  TextColumn get tableLabel => text()();
  TextColumn get status => text()();
  RealColumn get totalAmount => real()();
  TextColumn get note => text().nullable()();
  TextColumn get source => text()();
  DateTimeColumn get createdAt => dateTime()();
  // JSON-encoded list of order items. We keep the full snapshot per order.
  TextColumn get itemsJson => text()();
  DateTimeColumn get cachedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column> get primaryKey => {id};
}

@DataClassName('PendingAction')
class PendingActions extends Table {
  IntColumn get id => integer().autoIncrement()();
  // 'order_status' (target=order_id, payload={status}) | 'print' (target=order_id, payload={type})
  TextColumn get actionType => text()();
  IntColumn get targetId => integer()();
  TextColumn get payloadJson => text()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get nextAttemptAt =>
      dateTime().withDefault(currentDateAndTime)();
}

@DriftDatabase(tables: [CachedOrders, PendingActions])
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(driftDatabase(name: 'pos_v2_offline'));

  @override
  int get schemaVersion => 1;
}

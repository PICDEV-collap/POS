/// One {group, value} from the customer's option-group selection,
/// e.g. {group: "ประเภท", value: "น้ำ"}.
class OrderItemOption {
  final String group;
  final String value;
  final double priceDelta;
  OrderItemOption({
    required this.group,
    required this.value,
    this.priceDelta = 0,
  });
  factory OrderItemOption.fromJson(Map<String, dynamic> j) => OrderItemOption(
    group: j['group']?.toString() ?? '',
    value: j['value']?.toString() ?? '',
    priceDelta: double.tryParse((j['price_delta'] ?? 0).toString()) ?? 0,
  );
  Map<String, dynamic> toJson() => {
    'group': group,
    'value': value,
    if (priceDelta != 0) 'price_delta': priceDelta,
  };
}

class OrderItem {
  final int id;
  // Nullable: backend keeps the row but nulls product_id when admin
  // hard-deletes the product (FK ON DELETE SET NULL). The snapshot fields
  // below — productName, unitPrice — keep the order display intact.
  final int? productId;
  final String productName;
  final double unitPrice;
  final int quantity;
  final String? note;
  final String? variantName;
  final String fulfillmentType;
  final List<OrderItemOption> optionsSelected;
  final String status;

  OrderItem({
    required this.id,
    this.productId,
    required this.productName,
    required this.unitPrice,
    required this.quantity,
    this.note,
    this.variantName,
    this.fulfillmentType = 'dine-in',
    this.optionsSelected = const [],
    required this.status,
  });

  factory OrderItem.fromJson(Map<String, dynamic> j) => OrderItem(
    id: j['id'] as int,
    productId: j['product_id'] as int?,
    productName: j['product_name'] as String,
    unitPrice: double.parse(j['unit_price'].toString()),
    quantity: j['quantity'] as int,
    note: j['note'] as String?,
    variantName: j['variant_name'] as String?,
    fulfillmentType: j['fulfillment_type']?.toString() ?? 'dine-in',
    optionsSelected:
        (j['options_selected'] as List?)
            ?.map((e) => OrderItemOption.fromJson(e as Map<String, dynamic>))
            .toList() ??
        const [],
    status: j['status'] as String,
  );
}

class PosOrder {
  final int id;
  final int dailySeq;
  final String? businessDate;
  final int tableId;
  final String tableCode;
  final String tableName;
  final String status;
  final double totalAmount;
  final String? note;
  final String source;
  final String fulfillmentSummary;
  final DateTime createdAt;
  final List<OrderItem> items;
  final int itemCount;

  PosOrder({
    required this.id,
    required this.dailySeq,
    this.businessDate,
    required this.tableId,
    required this.tableCode,
    required this.tableName,
    required this.status,
    required this.totalAmount,
    this.note,
    required this.source,
    this.fulfillmentSummary = 'dine-in',
    required this.createdAt,
    required this.items,
    int? itemCount,
  }) : itemCount = itemCount ?? items.length;

  PosOrder copyWith({
    int? id,
    int? dailySeq,
    String? businessDate,
    int? tableId,
    String? tableCode,
    String? tableName,
    String? status,
    double? totalAmount,
    String? note,
    String? source,
    String? fulfillmentSummary,
    DateTime? createdAt,
    List<OrderItem>? items,
    int? itemCount,
  }) => PosOrder(
    id: id ?? this.id,
    dailySeq: dailySeq ?? this.dailySeq,
    businessDate: businessDate ?? this.businessDate,
    tableId: tableId ?? this.tableId,
    tableCode: tableCode ?? this.tableCode,
    tableName: tableName ?? this.tableName,
    status: status ?? this.status,
    totalAmount: totalAmount ?? this.totalAmount,
    note: note ?? this.note,
    source: source ?? this.source,
    fulfillmentSummary: fulfillmentSummary ?? this.fulfillmentSummary,
    createdAt: createdAt ?? this.createdAt,
    items: items ?? this.items,
    itemCount: itemCount ?? this.itemCount,
  );

  factory PosOrder.fromJson(Map<String, dynamic> j) {
    final items =
        (j['items'] as List?)
            ?.map((it) => OrderItem.fromJson(it as Map<String, dynamic>))
            .toList() ??
        const <OrderItem>[];
    return PosOrder(
      id: j['id'] as int,
      dailySeq: (j['daily_seq'] as int?) ?? (j['id'] as int),
      businessDate: j['business_date']?.toString(),
      tableId: j['table_id'] as int,
      tableCode: j['table_code']?.toString() ?? '',
      tableName: j['table_name']?.toString() ?? '',
      status: j['status'] as String,
      totalAmount: double.parse(j['total_amount'].toString()),
      note: j['note'] as String?,
      source: j['source'] as String? ?? 'unknown',
      fulfillmentSummary:
          j['fulfillment_summary']?.toString() ??
          j['order_type']?.toString() ??
          'dine-in',
      createdAt: DateTime.parse(j['created_at'] as String),
      items: items,
      itemCount: int.tryParse((j['item_count'] ?? items.length).toString()),
    );
  }
}

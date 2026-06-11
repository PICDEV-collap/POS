class Category {
  final int id;
  final String name;
  final String? icon;
  final int sortOrder;
  final bool isActive;
  Category({
    required this.id,
    required this.name,
    this.icon,
    required this.sortOrder,
    required this.isActive,
  });
  factory Category.fromJson(Map<String, dynamic> j) => Category(
    id: j['id'] as int,
    name: j['name'] as String,
    icon: j['icon'] as String?,
    sortOrder: j['sort_order'] as int? ?? 0,
    isActive: j['is_active'] as bool? ?? true,
  );
}

class Variant {
  final String name;
  final double price;
  Variant({required this.name, required this.price});
  factory Variant.fromJson(Map<String, dynamic> j) => Variant(
    name: j['name'] as String,
    price: double.parse(j['price'].toString()),
  );
  Map<String, dynamic> toJson() => {'name': name, 'price': price};
}

class OptionItem {
  final String? id;
  final String name;
  final double priceDelta;
  final bool isDefault;
  final bool isAvailable;
  final int sortOrder;
  OptionItem({
    this.id,
    required this.name,
    this.priceDelta = 0,
    this.isDefault = false,
    this.isAvailable = true,
    this.sortOrder = 0,
  });
  factory OptionItem.fromJson(
    dynamic raw, {
    List<String> defaultValues = const [],
    int sortOrder = 0,
  }) {
    if (raw is String) {
      return OptionItem(
        name: raw,
        isDefault: defaultValues.contains(raw),
        sortOrder: sortOrder,
      );
    }
    final j = raw as Map<String, dynamic>;
    final name = (j['name'] ?? j['value'] ?? '').toString();
    return OptionItem(
      id: j['id']?.toString(),
      name: name,
      priceDelta:
          double.tryParse(
            (j['price_delta'] ?? j['extra_price'] ?? 0).toString(),
          ) ??
          0,
      isDefault: j['is_default'] as bool? ?? defaultValues.contains(name),
      isAvailable: j['is_available'] as bool? ?? true,
      sortOrder: j['sort_order'] as int? ?? sortOrder,
    );
  }
  Map<String, dynamic> toJson() => {
    if (id != null) 'id': id,
    'name': name,
    'price_delta': priceDelta,
    'is_default': isDefault,
    'is_available': isAvailable,
    'sort_order': sortOrder,
  };
}

/// Backward-compatible option group. Legacy clients used `{name, choices}`.
/// New backend also supports min/max, defaults, add-on prices, and conditions.
class OptionGroup {
  final String? id;
  final String name;
  final String type;
  final bool required;
  final int minSelect;
  final int maxSelect;
  final bool isAvailable;
  final int sortOrder;
  final Map<String, dynamic>? visibleWhen;
  final List<OptionItem> items;
  List<String> get choices => items.map((e) => e.name).toList();

  OptionGroup({
    this.id,
    required this.name,
    List<String> choices = const [],
    List<OptionItem>? items,
    this.type = 'single',
    this.required = true,
    int? minSelect,
    int? maxSelect,
    this.isAvailable = true,
    this.sortOrder = 0,
    this.visibleWhen,
  }) : items =
           items ??
           choices
               .asMap()
               .entries
               .map((e) => OptionItem(name: e.value, sortOrder: e.key))
               .toList(),
       minSelect = minSelect ?? (required ? 1 : 0),
       maxSelect =
           maxSelect ??
           (type == 'single'
               ? 1
               : (items?.length ?? choices.length).clamp(1, 999));

  factory OptionGroup.fromJson(Map<String, dynamic> j) {
    final defaultValues =
        (j['default_values'] as List?)?.map((e) => e.toString()).toList() ??
        const <String>[];
    final rawItems =
        (j['items'] as List?) ?? (j['choices'] as List?) ?? const [];
    final items = rawItems
        .asMap()
        .entries
        .map(
          (e) => OptionItem.fromJson(
            e.value,
            defaultValues: defaultValues,
            sortOrder: e.key,
          ),
        )
        .where((e) => e.name.isNotEmpty)
        .toList();
    final rawType = (j['type'] ?? j['selection_type'] ?? '').toString();
    final type = rawType == 'multiple' || j['mutex'] == false
        ? 'multiple'
        : 'single';
    final required =
        j['required'] as bool? ?? j['is_required'] as bool? ?? true;
    return OptionGroup(
      id: j['id']?.toString(),
      name: (j['name'] ?? '').toString(),
      items: items,
      type: type,
      required: required,
      minSelect:
          int.tryParse(
            (j['min_select'] ?? j['min'] ?? (required ? 1 : 0)).toString(),
          ) ??
          (required ? 1 : 0),
      maxSelect: type == 'single'
          ? 1
          : (int.tryParse(
                      (j['max_select'] ?? j['max'] ?? items.length).toString(),
                    ) ??
                    items.length)
                .clamp(1, 999),
      isAvailable: j['is_available'] as bool? ?? true,
      sortOrder: j['sort_order'] as int? ?? 0,
      visibleWhen: j['visible_when'] is Map
          ? Map<String, dynamic>.from(j['visible_when'] as Map)
          : null,
    );
  }

  OptionGroup copyWith({
    String? name,
    List<OptionItem>? items,
    String? type,
    bool? required,
    int? minSelect,
    int? maxSelect,
    bool? isAvailable,
    int? sortOrder,
    Map<String, dynamic>? visibleWhen,
  }) => OptionGroup(
    id: id,
    name: name ?? this.name,
    items: items ?? this.items,
    type: type ?? this.type,
    required: required ?? this.required,
    minSelect: minSelect ?? this.minSelect,
    maxSelect: maxSelect ?? this.maxSelect,
    isAvailable: isAvailable ?? this.isAvailable,
    sortOrder: sortOrder ?? this.sortOrder,
    visibleWhen: visibleWhen ?? this.visibleWhen,
  );

  Map<String, dynamic> toJson() => {
    if (id != null) 'id': id,
    'name': name,
    'type': type,
    'required': required,
    'min_select': minSelect,
    'max_select': maxSelect,
    'sort_order': sortOrder,
    'is_available': isAvailable,
    'choices': choices,
    'default_values': items
        .where((e) => e.isDefault)
        .map((e) => e.name)
        .toList(),
    'items': items.map((e) => e.toJson()).toList(),
    if (visibleWhen != null) 'visible_when': visibleWhen,
  };
}

class Product {
  final int id;
  final int? categoryId;
  final String name;
  final String? description;
  final double price;
  final String? imageUrl;
  final String? emoji;
  final bool isPopular;
  final List<OptionGroup>? options;
  final List<Variant>? variants;
  final bool isAvailable;
  final int sortOrder;
  final String productType;
  final String? barcode;
  final bool trackStock;
  final double stockQty;
  final double stockAlertQty;
  final String? printStationKey;

  Product({
    required this.id,
    this.categoryId,
    required this.name,
    this.description,
    required this.price,
    this.imageUrl,
    this.emoji,
    required this.isPopular,
    this.options,
    this.variants,
    required this.isAvailable,
    required this.sortOrder,
    this.productType = 'food',
    this.barcode,
    this.trackStock = false,
    this.stockQty = 0,
    this.stockAlertQty = 0,
    this.printStationKey,
  });

  factory Product.fromJson(Map<String, dynamic> j) => Product(
    id: j['id'] as int,
    categoryId: j['category_id'] as int?,
    name: j['name'] as String,
    description: j['description'] as String?,
    price: double.parse(j['price'].toString()),
    imageUrl: j['image_url'] as String?,
    emoji: j['emoji'] as String?,
    isPopular: j['is_popular'] as bool? ?? false,
    options: (j['options'] as List?)
        ?.where((e) => e is Map)
        .map((e) => OptionGroup.fromJson(e as Map<String, dynamic>))
        .toList(),
    variants: (j['variants'] as List?)
        ?.map((v) => Variant.fromJson(v as Map<String, dynamic>))
        .toList(),
    isAvailable: j['is_available'] as bool? ?? true,
    sortOrder: j['sort_order'] as int? ?? 0,
    productType: j['product_type'] as String? ?? 'food',
    barcode: j['barcode'] as String?,
    trackStock: j['track_stock'] as bool? ?? false,
    stockQty: double.tryParse((j['stock_qty'] ?? 0).toString()) ?? 0,
    stockAlertQty: double.tryParse((j['stock_alert_qty'] ?? 0).toString()) ?? 0,
    printStationKey: j['print_station_key'] as String?,
  );
}

class PosTable {
  final int id;
  final String code;
  final String name;
  final int seats;
  final String qrToken;
  final bool isActive;
  final bool isTakeaway;
  PosTable({
    required this.id,
    required this.code,
    required this.name,
    required this.seats,
    required this.qrToken,
    required this.isActive,
    required this.isTakeaway,
  });
  factory PosTable.fromJson(Map<String, dynamic> j) {
    final code = j['code'] as String? ?? '';
    final seats = j['seats'] as int? ?? 4;
    return PosTable(
      id: j['id'] as int,
      code: code,
      name: j['name'] as String,
      seats: seats,
      qrToken: j['qr_token'] as String,
      isActive: j['is_active'] as bool? ?? true,
      isTakeaway:
          j['is_takeaway'] as bool? ??
          (code.toUpperCase() == 'TAKEAWAY' || seats == 0),
    );
  }
}

class RestaurantSettings {
  final String name;
  final String? logo;
  final String currency;
  final bool paymentQrEnabled;
  final String paymentQrType;
  final String? paymentQrId;
  final String? paymentQrRawPayload;
  final String? paymentQrAccountName;
  final String paymentQrLabel;
  final bool paymentQrIncludeAmount;
  final String paymentQrRef1Prefix;
  final String? paymentQrRef2;
  final bool paymentAutoCloseEnabled;
  final bool orderingEnabled;
  final String orderingOpenTime;
  final String orderingCloseTime;
  final String orderingTimezone;
  final bool orderingRequireSession;
  final bool orderingRequirePrivateIp;
  final bool orderingRequireGps;
  final double? orderingShopLat;
  final double? orderingShopLng;
  final int orderingMaxDistanceM;
  RestaurantSettings({
    required this.name,
    this.logo,
    required this.currency,
    this.paymentQrEnabled = false,
    this.paymentQrType = 'promptpay',
    this.paymentQrId,
    this.paymentQrRawPayload,
    this.paymentQrAccountName,
    this.paymentQrLabel = 'สแกนจ่ายเงิน',
    this.paymentQrIncludeAmount = true,
    this.paymentQrRef1Prefix = 'ORDER',
    this.paymentQrRef2,
    this.paymentAutoCloseEnabled = true,
    this.orderingEnabled = true,
    this.orderingOpenTime = '00:00',
    this.orderingCloseTime = '23:59',
    this.orderingTimezone = 'Asia/Bangkok',
    this.orderingRequireSession = true,
    this.orderingRequirePrivateIp = false,
    this.orderingRequireGps = false,
    this.orderingShopLat,
    this.orderingShopLng,
    this.orderingMaxDistanceM = 20,
  });

  static String _time5(dynamic value, String fallback) {
    final raw = (value as String?)?.trim();
    if (raw == null || raw.isEmpty) return fallback;
    final m = RegExp(r'^(\d{1,2}):(\d{2})').firstMatch(raw);
    if (m == null) return fallback;
    final h = int.tryParse(m.group(1) ?? '') ?? 0;
    final min = int.tryParse(m.group(2) ?? '') ?? 0;
    return '${h.clamp(0, 23).toString().padLeft(2, '0')}:${min.clamp(0, 59).toString().padLeft(2, '0')}';
  }

  factory RestaurantSettings.fromJson(
    Map<String, dynamic> j,
  ) => RestaurantSettings(
    name: j['name'] as String? ?? 'POS V2',
    logo: j['logo'] as String?,
    currency: j['currency'] as String? ?? '฿',
    paymentQrEnabled: j['payment_qr_enabled'] as bool? ?? false,
    paymentQrType: j['payment_qr_type'] as String? ?? 'promptpay',
    paymentQrId: j['payment_qr_id'] as String?,
    paymentQrRawPayload: j['payment_qr_raw_payload'] as String?,
    paymentQrAccountName: j['payment_qr_account_name'] as String?,
    paymentQrLabel: j['payment_qr_label'] as String? ?? 'สแกนจ่ายเงิน',
    paymentQrIncludeAmount: j['payment_qr_include_amount'] as bool? ?? true,
    paymentQrRef1Prefix: j['payment_qr_ref1_prefix'] as String? ?? 'ORDER',
    paymentQrRef2: j['payment_qr_ref2'] as String?,
    paymentAutoCloseEnabled: j['payment_auto_close_enabled'] as bool? ?? true,
    orderingEnabled: j['ordering_enabled'] as bool? ?? true,
    orderingOpenTime: _time5(j['ordering_open_time'], '00:00'),
    orderingCloseTime: _time5(j['ordering_close_time'], '23:59'),
    orderingTimezone: j['ordering_timezone'] as String? ?? 'Asia/Bangkok',
    orderingRequireSession: j['ordering_require_session'] as bool? ?? true,
    orderingRequirePrivateIp:
        j['ordering_require_private_ip'] as bool? ?? false,
    orderingRequireGps: j['ordering_require_gps'] as bool? ?? false,
    orderingShopLat: double.tryParse((j['ordering_shop_lat'] ?? '').toString()),
    orderingShopLng: double.tryParse((j['ordering_shop_lng'] ?? '').toString()),
    orderingMaxDistanceM:
        int.tryParse((j['ordering_max_distance_m'] ?? 20).toString()) ?? 20,
  );
}

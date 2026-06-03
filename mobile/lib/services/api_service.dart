import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';
import '../models/order.dart';
import '../models/product.dart';
import 'auth_service.dart';

class ApiException implements Exception {
  final int statusCode;
  final String message;
  ApiException(this.statusCode, this.message);
  @override
  String toString() =>
      statusCode == 0 ? message : 'ApiException($statusCode): $message';
}

class ApiService {
  static const Duration requestTimeout = Duration(seconds: 8);
  static const int _localOrderDetailConcurrency = 8;
  static const int _remoteOrderDetailConcurrency = 3;
  final AuthService auth;
  ApiService(this.auth);

  Map<String, String> _headers({bool json = true}) {
    final h = <String, String>{...AppConfig.tunnelHeaders};
    if (json) h['Content-Type'] = 'application/json';
    final t = auth.token;
    if (t != null) h['Authorization'] = 'Bearer $t';
    final storeId = auth.activeStoreId;
    if (storeId != null) h['X-POS-Store-ID'] = '$storeId';
    return h;
  }

  String _storeQuery({String prefix = '?'}) {
    final storeId = auth.activeStoreId;
    return storeId == null ? '' : '${prefix}store_id=$storeId';
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    try {
      return await _sendOnce(method, path, body);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (AppConfig.isHandshakeError(e) &&
          await AppConfig.repairBaseAfterHandshake()) {
        return _sendOnce(method, path, body);
      }
      throw ApiException(0, AppConfig.friendlyNetworkError(e));
    }
  }

  Future<dynamic> _sendOnce(String method, String path, [Object? body]) async {
    final uri = Uri.parse('${AppConfig.apiBase}$path');
    final req = http.Request(method, uri);
    req.headers.addAll(_headers());
    if (body != null) req.body = jsonEncode(body);
    final client = AppConfig.httpClientFor();
    try {
      final streamed = await client.send(req).timeout(requestTimeout);
      final res = await http.Response.fromStream(
        streamed,
      ).timeout(requestTimeout);
      if (res.statusCode == 401) {
        if (await auth.refreshSession()) {
          return _sendOnce(method, path, body);
        }
        await auth.logout();
        throw ApiException(401, 'session expired');
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        String msg = 'HTTP ${res.statusCode}';
        try {
          msg = (jsonDecode(res.body) as Map)['error']?.toString() ?? msg;
        } catch (_) {}
        throw ApiException(res.statusCode, msg);
      }
      if (res.statusCode == 204 || res.body.isEmpty) return null;
      return jsonDecode(utf8.decode(res.bodyBytes));
    } finally {
      client.close();
    }
  }

  Future<List<PosOrder>> listOrders({
    String? status,
    bool includeDetails = true,
  }) async {
    final qs = status != null ? '?status=$status' : '';
    final list = await _send('GET', '/api/orders$qs') as List;
    if (!includeDetails) {
      return list
          .map((j) => PosOrder.fromJson(j as Map<String, dynamic>))
          .toList();
    }
    final concurrency = AppConfig.isPublicRemoteBase
        ? _remoteOrderDetailConcurrency
        : _localOrderDetailConcurrency;
    final detailed = await _mapLimited<Map<String, dynamic>, PosOrder>(
      list.cast<Map<String, dynamic>>(),
      concurrency,
      (o) async {
        final id = o['id'] as int;
        final full =
            await _send('GET', '/api/orders/$id') as Map<String, dynamic>;
        return PosOrder.fromJson(full);
      },
    );
    return detailed;
  }

  Future<List<R>> _mapLimited<T, R>(
    List<T> items,
    int concurrency,
    Future<R> Function(T item) mapper,
  ) async {
    if (items.isEmpty) return <R>[];
    final limit = concurrency.clamp(1, items.length);
    final results = List<R?>.filled(items.length, null);
    var nextIndex = 0;

    Future<void> worker() async {
      while (true) {
        final current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) return;
        results[current] = await mapper(items[current]);
      }
    }

    await Future.wait(List.generate(limit, (_) => worker()));
    return [for (final result in results) result as R];
  }

  Future<PosOrder> getOrder(int id) async {
    final j = await _send('GET', '/api/orders/$id') as Map<String, dynamic>;
    return PosOrder.fromJson(j);
  }

  Future<PosOrder> updateOrderStatus(int id, String status) async {
    final j =
        await _send('PATCH', '/api/orders/$id/status', {'status': status})
            as Map<String, dynamic>;
    return PosOrder.fromJson(j);
  }

  Future<Map<String, dynamic>> printOrder(int id, String type) async {
    return await _send('POST', '/api/print/order/$id?type=$type')
        as Map<String, dynamic>;
  }

  /// Enqueue a QR-label thermal print so staff can hand a paper QR to
  /// customers who can't scan the screen. Backed by POST /api/print/qr.
  Future<Map<String, dynamic>> printQrLabel({
    required String url,
    String? tableName,
    String? tableCode,
    String? storeName,
    String? storeLogo,
    String? note,
    String? footer,
    int copies = 1,
  }) async {
    final body = <String, dynamic>{
      'url': url,
      if (tableName != null && tableName.isNotEmpty) 'table_name': tableName,
      if (tableCode != null && tableCode.isNotEmpty) 'table_code': tableCode,
      if (storeName != null && storeName.isNotEmpty) 'store_name': storeName,
      if (storeLogo != null && storeLogo.isNotEmpty) 'store_logo': storeLogo,
      if (note != null && note.isNotEmpty) 'note': note,
      if (footer != null && footer.isNotEmpty) 'footer': footer,
      'copies': copies.clamp(1, 8),
    };
    return await _send('POST', '/api/print/qr', body)
        as Map<String, dynamic>;
  }

  /// Enqueue a thermal barcode label print for a product. Optional
  /// [stationKey] picks a specific printer station; otherwise the
  /// system-default printer is used.
  Future<Map<String, dynamic>> printBarcodeLabel(
    int productId, {
    String? stationKey,
    int copies = 1,
    int barcodeHeightPx = 80,
  }) async {
    final body = <String, dynamic>{
      'copies': copies.clamp(1, 8),
      'barcode_height_px': barcodeHeightPx,
      if (stationKey != null && stationKey.isNotEmpty) 'station_key': stationKey,
    };
    return await _send('POST', '/api/print/barcode/$productId', body)
        as Map<String, dynamic>;
  }

  /// List configured print stations so the UI can let the user pick one.
  Future<List<Map<String, dynamic>>> printStations() async {
    final list = await _send('GET', '/api/print/stations') as List;
    return list.map((j) => Map<String, dynamic>.from(j as Map)).toList();
  }

  Future<Map<String, dynamic>> claimMobilePrint(
    int orderId,
    String type,
  ) async {
    return await _send('POST', '/api/print/mobile-claim', {
          'order_id': orderId,
          'type': type,
        })
        as Map<String, dynamic>;
  }

  Future<void> completeMobilePrintClaim(
    int claimId, {
    required bool ok,
    String? error,
  }) async {
    await _send('POST', '/api/print/mobile-claim/$claimId/complete', {
      'ok': ok,
      if (error != null) 'error': error,
    });
  }

  /// Returns a Map { type, order_id, bytes_base64, bytes_length, render_mode }
  /// from /api/print/payload/order/:id?type=kitchen|receipt — used by the
  /// mobile Bluetooth printer flow (mobile receives bytes then writes them
  /// directly to a paired BT thermal printer).
  String _printQuery({
    int? widthPx,
    int? widthChars,
    String? renderMode,
    String? protocol,
    int? labelWidthMm,
    int? labelHeightMm,
    int? gapMm,
    int? blineMm,
    String? paperType,
  }) {
    final qs = <String>[];
    if (widthPx != null) qs.add('width_px=$widthPx');
    if (widthChars != null) qs.add('width_chars=$widthChars');
    if (renderMode != null) qs.add('render_mode=$renderMode');
    if (protocol != null) qs.add('protocol=$protocol');
    if (labelWidthMm != null) qs.add('label_width_mm=$labelWidthMm');
    if (labelHeightMm != null) qs.add('label_height_mm=$labelHeightMm');
    if (gapMm != null) qs.add('gap_mm=$gapMm');
    if (blineMm != null) qs.add('bline_mm=$blineMm');
    if (paperType != null) qs.add('paper_type=$paperType');
    return qs.join('&');
  }

  Future<Map<String, dynamic>> getPrintPayload(
    int orderId,
    String type, {
    int? widthPx,
    int? widthChars,
    String? renderMode,
    String? protocol,
    int? labelWidthMm,
    int? labelHeightMm,
    int? gapMm,
    int? blineMm,
    String? paperType,
  }) async {
    final base = 'type=$type';
    final more = _printQuery(
      widthPx: widthPx,
      widthChars: widthChars,
      renderMode: renderMode,
      protocol: protocol,
      labelWidthMm: labelWidthMm,
      labelHeightMm: labelHeightMm,
      gapMm: gapMm,
      blineMm: blineMm,
      paperType: paperType,
    );
    final qs = more.isEmpty ? base : '$base&$more';
    return await _send('GET', '/api/print/payload/order/$orderId?$qs')
        as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getTestPrintPayload({
    int? widthPx,
    int? widthChars,
    String? renderMode,
    String? protocol,
    int? labelWidthMm,
    int? labelHeightMm,
    int? gapMm,
    int? blineMm,
    String? paperType,
  }) async {
    final qs = _printQuery(
      widthPx: widthPx,
      widthChars: widthChars,
      renderMode: renderMode,
      protocol: protocol,
      labelWidthMm: labelWidthMm,
      labelHeightMm: labelHeightMm,
      gapMm: gapMm,
      blineMm: blineMm,
      paperType: paperType,
    );
    final query = qs.isEmpty ? '' : '?$qs';
    return await _send('GET', '/api/print/payload/test$query')
        as Map<String, dynamic>;
  }

  /// One-shot printer calibration payload. `paperType` is `gap` or `bline`;
  /// for `continuous` the printer needs no calibration.
  Future<Map<String, dynamic>> getCalibratePayload({
    required String paperType,
    int? labelWidthMm,
    int? labelHeightMm,
  }) async {
    final qs = _printQuery(
      protocol: 'tspl',
      paperType: paperType,
      labelWidthMm: labelWidthMm,
      labelHeightMm: labelHeightMm,
    );
    return await _send('GET', '/api/print/payload/calibrate?$qs')
        as Map<String, dynamic>;
  }

  // ─── Catalog (no auth) ──────────────────────────────────────────────
  Future<Map<String, dynamic>> publicMenu({bool includeUnavailable = false}) async {
    final storeQ = _storeQuery();
    final unavailableQ = includeUnavailable ? 'include_unavailable=1' : '';
    final qs = [
      if (storeQ.isNotEmpty) storeQ.replaceFirst('?', ''),
      if (unavailableQ.isNotEmpty) unavailableQ,
    ].join('&');
    final path = qs.isEmpty ? '/api/public/menu' : '/api/public/menu?$qs';
    final res = await _getWithHandshakeRepair(path);
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  /// Quick toggle ปิดการขาย / เปิดขาย — used by staff during a shift to
  /// hide a sold-out product from customers without going to admin.
  Future<Map<String, dynamic>> setProductAvailability(
    int productId, {
    required bool isAvailable,
  }) async {
    return await _send(
      'PATCH',
      '/api/products/$productId/availability',
      {'is_available': isAvailable},
    ) as Map<String, dynamic>;
  }

  Future<List<Category>> categories() async {
    final list = await _send('GET', '/api/categories${_storeQuery()}') as List;
    return list
        .map((j) => Category.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<List<Product>> products() async {
    final list = await _send('GET', '/api/products${_storeQuery()}') as List;
    return list
        .map((j) => Product.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<List<PosTable>> tables() async {
    final list = await _send('GET', '/api/tables') as List;
    return list
        .map((j) => PosTable.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<PosTable> rotateTableQr(int id) async {
    final j =
        await _send('POST', '/api/tables/$id/rotate-qr')
            as Map<String, dynamic>;
    return PosTable.fromJson(j);
  }

  Future<Map<String, dynamic>> rotateAllTableQr() async {
    return await _send('POST', '/api/tables/rotate-qr-all')
        as Map<String, dynamic>;
  }

  // ─── Staff: place order on behalf of table ──────────────────────────
  Future<PosOrder> placeStaffOrder({
    required int tableId,
    required List<Map<String, dynamic>> items,
    String? note,
    String? orderType,
    String? customerName,
  }) async {
    final body = <String, dynamic>{'table_id': tableId, 'items': items};
    final storeId = auth.activeStoreId;
    if (storeId != null) body['store_id'] = storeId;
    if (note != null && note.isNotEmpty) body['note'] = note;
    if (orderType != null) body['order_type'] = orderType;
    if (customerName != null && customerName.isNotEmpty) {
      body['customer_name'] = customerName;
    }
    final j = await _send('POST', '/api/orders', body) as Map<String, dynamic>;
    return PosOrder.fromJson(j);
  }

  String qrUrl(String text, {int size = 240}) {
    final t = Uri.encodeComponent(text);
    return '${AppConfig.apiBase}/api/qr?size=$size&text=$t';
  }

  /// Returns backend's `/api/discovery/info` payload — includes
  /// `public_base_url` (Caddy/ngrok URL) so the app can build customer-facing
  /// QR codes that work outside the LAN.
  Future<Map<String, dynamic>> getDiscoveryInfo() async {
    final res = await _getWithHandshakeRepair('/api/discovery/info');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  Future<http.Response> _getWithHandshakeRepair(String path) async {
    try {
      return await _getOnce(path);
    } catch (e) {
      if (AppConfig.isHandshakeError(e) &&
          await AppConfig.repairBaseAfterHandshake()) {
        return _getOnce(path);
      }
      throw ApiException(0, AppConfig.friendlyNetworkError(e));
    }
  }

  Future<http.Response> _getOnce(String path) async {
    final client = AppConfig.httpClientFor();
    try {
      return await client
          .get(
            Uri.parse('${AppConfig.apiBase}$path'),
            headers: AppConfig.tunnelHeaders,
          )
          .timeout(requestTimeout);
    } finally {
      client.close();
    }
  }

  String imageUrl(String? path) {
    if (path == null || path.isEmpty) return '';
    if (path.startsWith('http')) return path;
    return '${AppConfig.apiBase}$path';
  }

  // Public-facing wrapper around the private _send for callers that need
  // raw access (e.g. printer config + test endpoints).
  Future<dynamic> request(String method, String path, [Object? body]) =>
      _send(method, path, body);

  // ─── Stores / branches ───────────────────────────────────────────────
  Future<List<PosStore>> stores() async {
    final list = await _send('GET', '/api/stores') as List;
    return list
        .map((j) => PosStore.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<void> deleteStore(int id) async {
    await _send('DELETE', '/api/stores/$id');
  }

  // ─── Settings ────────────────────────────────────────────────────────
  Future<RestaurantSettings> getSettings() async {
    final j = await _send('GET', '/api/settings') as Map<String, dynamic>;
    return RestaurantSettings.fromJson(j);
  }

  Future<RestaurantSettings> updateSettings({
    String? name,
    String? logo,
    String? currency,
    bool? paymentQrEnabled,
    String? paymentQrType,
    String? paymentQrId,
    String? paymentQrRawPayload,
    String? paymentQrAccountName,
    String? paymentQrLabel,
    bool? paymentQrIncludeAmount,
    String? paymentQrRef1Prefix,
    String? paymentQrRef2,
    bool? paymentAutoCloseEnabled,
    bool? orderingEnabled,
    String? orderingOpenTime,
    String? orderingCloseTime,
    String? orderingTimezone,
    bool? orderingRequireSession,
    bool? orderingRequirePrivateIp,
    bool? orderingRequireGps,
    double? orderingShopLat,
    double? orderingShopLng,
    int? orderingMaxDistanceM,
  }) async {
    final j =
        await _send('PUT', '/api/settings', {
              if (name != null) 'name': name,
              if (logo != null) 'logo': logo,
              if (currency != null) 'currency': currency,
              if (paymentQrEnabled != null)
                'payment_qr_enabled': paymentQrEnabled,
              if (paymentQrType != null) 'payment_qr_type': paymentQrType,
              if (paymentQrId != null) 'payment_qr_id': paymentQrId,
              if (paymentQrRawPayload != null)
                'payment_qr_raw_payload': paymentQrRawPayload,
              if (paymentQrAccountName != null)
                'payment_qr_account_name': paymentQrAccountName,
              if (paymentQrLabel != null) 'payment_qr_label': paymentQrLabel,
              if (paymentQrIncludeAmount != null)
                'payment_qr_include_amount': paymentQrIncludeAmount,
              if (paymentQrRef1Prefix != null)
                'payment_qr_ref1_prefix': paymentQrRef1Prefix,
              if (paymentQrRef2 != null) 'payment_qr_ref2': paymentQrRef2,
              if (paymentAutoCloseEnabled != null)
                'payment_auto_close_enabled': paymentAutoCloseEnabled,
              if (orderingEnabled != null) 'ordering_enabled': orderingEnabled,
              if (orderingOpenTime != null)
                'ordering_open_time': orderingOpenTime,
              if (orderingCloseTime != null)
                'ordering_close_time': orderingCloseTime,
              if (orderingTimezone != null)
                'ordering_timezone': orderingTimezone,
              if (orderingRequireSession != null)
                'ordering_require_session': orderingRequireSession,
              if (orderingRequirePrivateIp != null)
                'ordering_require_private_ip': orderingRequirePrivateIp,
              if (orderingRequireGps != null)
                'ordering_require_gps': orderingRequireGps,
              if (orderingShopLat != null) 'ordering_shop_lat': orderingShopLat,
              if (orderingShopLng != null) 'ordering_shop_lng': orderingShopLng,
              if (orderingMaxDistanceM != null)
                'ordering_max_distance_m': orderingMaxDistanceM,
            })
            as Map<String, dynamic>;
    return RestaurantSettings.fromJson(j);
  }

  // ─── Products CRUD ───────────────────────────────────────────────────
  Future<Product> createProduct(Map<String, dynamic> data) async {
    final j =
        await _send('POST', '/api/products', data) as Map<String, dynamic>;
    return Product.fromJson(j);
  }

  Future<Product> updateProduct(int id, Map<String, dynamic> data) async {
    final j =
        await _send('PUT', '/api/products/$id', data) as Map<String, dynamic>;
    return Product.fromJson(j);
  }

  Future<Product> productByBarcode(String barcode) async {
    final j =
        await _send(
              'GET',
              '/api/products/barcode/${Uri.encodeComponent(barcode)}',
            )
            as Map<String, dynamic>;
    return Product.fromJson(j);
  }

  Future<void> deleteProduct(int id) async {
    await _send('DELETE', '/api/products/$id');
  }

  Future<Product> uploadProductImage(int id, String filePath) async {
    try {
      return await _uploadProductImageOnce(id, filePath);
    } catch (e) {
      if (e is ApiException) rethrow;
      if (AppConfig.isHandshakeError(e) &&
          await AppConfig.repairBaseAfterHandshake()) {
        return _uploadProductImageOnce(id, filePath);
      }
      throw ApiException(0, AppConfig.friendlyNetworkError(e));
    }
  }

  Future<Product> _uploadProductImageOnce(int id, String filePath) async {
    final auth = this.auth;
    final uri = Uri.parse('${AppConfig.apiBase}/api/products/$id/image');
    final req = http.MultipartRequest('POST', uri);
    req.headers.addAll(AppConfig.tunnelHeaders);
    if (auth.token != null) {
      req.headers['Authorization'] = 'Bearer ${auth.token}';
    }
    final storeId = auth.activeStoreId;
    if (storeId != null) {
      req.headers['X-POS-Store-ID'] = '$storeId';
    }
    req.files.add(await http.MultipartFile.fromPath('image', filePath));
    final client = AppConfig.httpClientFor();
    try {
      final streamed = await client.send(req);
      final res = await http.Response.fromStream(streamed);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw ApiException(res.statusCode, 'image upload failed');
      }
      return Product.fromJson(
        jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>,
      );
    } finally {
      client.close();
    }
  }

  Future<void> deleteProductImage(int id) async {
    await _send('DELETE', '/api/products/$id/image');
  }

  // ─── Categories CRUD ─────────────────────────────────────────────────
  Future<List<Category>> categoriesAll() async {
    final list = await _send('GET', '/api/categories/all') as List;
    return list
        .map((j) => Category.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<Category> createCategory(Map<String, dynamic> data) async {
    final j =
        await _send('POST', '/api/categories', data) as Map<String, dynamic>;
    return Category.fromJson(j);
  }

  Future<Category> updateCategory(int id, Map<String, dynamic> data) async {
    final j =
        await _send('PUT', '/api/categories/$id', data) as Map<String, dynamic>;
    return Category.fromJson(j);
  }

  Future<void> deleteCategory(int id) async {
    await _send('DELETE', '/api/categories/$id');
  }

  // ─── Tables CRUD ─────────────────────────────────────────────────────
  Future<PosTable> createTable(Map<String, dynamic> data) async {
    final j = await _send('POST', '/api/tables', data) as Map<String, dynamic>;
    return PosTable.fromJson(j);
  }

  Future<PosTable> updateTable(int id, Map<String, dynamic> data) async {
    final j =
        await _send('PUT', '/api/tables/$id', data) as Map<String, dynamic>;
    return PosTable.fromJson(j);
  }

  Future<void> deleteTable(int id) async {
    await _send('DELETE', '/api/tables/$id');
  }
}

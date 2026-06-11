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
  String toString() => 'ApiException($statusCode): $message';
}

class ApiService {
  static const Duration requestTimeout = Duration(seconds: 8);
  final AuthService auth;
  ApiService(this.auth);

  Map<String, String> _headers({bool json = true}) {
    final h = <String, String>{};
    if (json) h['Content-Type'] = 'application/json';
    final t = auth.token;
    if (t != null) h['Authorization'] = 'Bearer $t';
    return h;
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    final uri = Uri.parse('${AppConfig.apiBase}$path');
    final req = http.Request(method, uri);
    req.headers.addAll(_headers());
    if (body != null) req.body = jsonEncode(body);
    final streamed = await req.send().timeout(requestTimeout);
    final res = await http.Response.fromStream(
      streamed,
    ).timeout(requestTimeout);
    if (res.statusCode == 401) {
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
  }

  Future<List<PosOrder>> listOrders({String? status}) async {
    final qs = status != null ? '?status=$status' : '';
    final list = await _send('GET', '/api/orders$qs') as List;
    final detailed = await Future.wait(
      list.map((o) async {
        final id = (o as Map)['id'] as int;
        final full =
            await _send('GET', '/api/orders/$id') as Map<String, dynamic>;
        return PosOrder.fromJson(full);
      }),
    );
    return detailed;
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
  Future<Map<String, dynamic>> publicMenu() async {
    final res = await http.get(
      Uri.parse('${AppConfig.apiBase}/api/public/menu'),
    );
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  Future<List<Category>> categories() async {
    final list = await _send('GET', '/api/categories') as List;
    return list
        .map((j) => Category.fromJson(j as Map<String, dynamic>))
        .toList();
  }

  Future<List<Product>> products() async {
    final list = await _send('GET', '/api/products') as List;
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
    final j =
        await _send('POST', '/api/orders', {
              'table_id': tableId,
              'items': items,
              if (note != null && note.isNotEmpty) 'note': note,
              if (orderType != null) 'order_type': orderType,
              if (customerName != null && customerName.isNotEmpty)
                'customer_name': customerName,
            })
            as Map<String, dynamic>;
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
    final res = await http.get(
      Uri.parse('${AppConfig.apiBase}/api/discovery/info'),
    );
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
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
    final auth = this.auth;
    final uri = Uri.parse('${AppConfig.apiBase}/api/products/$id/image');
    final req = http.MultipartRequest('POST', uri);
    if (auth.token != null)
      req.headers['Authorization'] = 'Bearer ${auth.token}';
    req.files.add(await http.MultipartFile.fromPath('image', filePath));
    final streamed = await req.send();
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, 'image upload failed');
    }
    return Product.fromJson(
      jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>,
    );
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

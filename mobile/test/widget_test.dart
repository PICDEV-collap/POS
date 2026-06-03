import 'package:flutter_test/flutter_test.dart';
import 'package:pos_v2_mobile/services/api_service.dart';

void main() {
  test('ApiException renders friendly network errors without status prefix', () {
    expect(ApiException(0, 'network unavailable').toString(), 'network unavailable');
  });

  test('ApiException includes HTTP status for server errors', () {
    expect(
      ApiException(400, 'product 13 not found').toString(),
      'ApiException(400): product 13 not found',
    );
  });
}

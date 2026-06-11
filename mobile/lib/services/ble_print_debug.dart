String blePrintOkMessage(
  Map<String, dynamic> payload, {
  String? writeChar,
  String? notifyAck,
}) {
  final proto = payload['protocol'] ?? payload['ble_profile'] ?? 'escpos';
  final bytes = payload['bytes_length'] ?? '?';
  return '✅ ส่งแล้ว · $bytes B · $proto · ch:${writeChar ?? '?'} · ack:${notifyAck ?? 'n/a'}';
}

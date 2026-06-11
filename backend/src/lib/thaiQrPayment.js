const PROMPTPAY_AID = 'A000000677010111';
const THAI_QR_BILL_PAYMENT_AID = 'A000000677010112';
const CURRENCY_THB = '764';
const COUNTRY_TH = 'TH';

function tlv(id, value) {
  const v = String(value ?? '');
  const len = Buffer.byteLength(v, 'ascii');
  if (len > 99) throw new Error(`TLV ${id} is too long (${len})`);
  return `${id}${String(len).padStart(2, '0')}${v}`;
}

function crc16CcittFalse(input) {
  let crc = 0xffff;
  const data = Buffer.from(input, 'ascii');
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function withCrc(payloadWithoutCrc) {
  const pending = `${payloadWithoutCrc}6304`;
  return `${pending}${crc16CcittFalse(pending)}`;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePromptPayId(value) {
  const target = digitsOnly(value);
  if (target.length === 10) {
    if (!target.startsWith('0')) throw new Error('PromptPay phone number must start with 0');
    return { subtag: '01', value: `0066${target.slice(1)}` };
  }
  if (target.length === 13) return { subtag: '02', value: target };
  if (target.length === 15) return { subtag: '03', value: target };
  throw new Error('PromptPay ID must be 10, 13, or 15 digits');
}

function normalizeBillerId(value) {
  const billerId = digitsOnly(value);
  if (billerId.length !== 15) throw new Error('Thai QR merchant/biller ID must be 15 digits');
  return billerId;
}

function normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function normalizeRef(value, fallback) {
  const ref = String(value || fallback || '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 20);
  if (!ref) throw new Error('Thai QR merchant ref1 is required');
  return ref;
}

function buildBase({ dynamic, merchantInfo, amount }) {
  let payload = '';
  payload += tlv('00', '01');
  payload += tlv('01', dynamic ? '12' : '11');
  payload += merchantInfo;
  payload += tlv('58', COUNTRY_TH);
  payload += tlv('53', CURRENCY_THB);
  if (amount) payload += tlv('54', amount);
  return withCrc(payload);
}

function buildPromptPayPayload(target, amount) {
  const id = normalizePromptPayId(target);
  const qrAmount = normalizeAmount(amount);
  const merchantInfo = tlv('29', tlv('00', PROMPTPAY_AID) + tlv(id.subtag, id.value));
  return buildBase({ dynamic: !!qrAmount, merchantInfo, amount: qrAmount });
}

function buildThaiQrMerchantPayload({ billerId, amount, ref1, ref2 }) {
  const qrAmount = normalizeAmount(amount);
  let merchant = tlv('00', THAI_QR_BILL_PAYMENT_AID);
  merchant += tlv('01', normalizeBillerId(billerId));
  merchant += tlv('02', normalizeRef(ref1));
  const cleanRef2 = String(ref2 || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);
  if (cleanRef2) merchant += tlv('03', cleanRef2);
  return buildBase({ dynamic: true, merchantInfo: tlv('30', merchant), amount: qrAmount });
}

function buildPaymentQrPayload(order, settings = {}) {
  if (!settings.payment_qr_enabled) return null;
  const type = settings.payment_qr_type || 'promptpay';
  const amount = settings.payment_qr_include_amount === false ? null : order?.total_amount;

  if (type === 'raw') {
    const raw = String(settings.payment_qr_raw_payload || '').trim();
    if (!raw) return null;
    return raw;
  }

  if (type === 'merchant') {
    const prefix = settings.payment_qr_ref1_prefix || 'ORDER';
    return buildThaiQrMerchantPayload({
      billerId: settings.payment_qr_id,
      amount,
      ref1: `${prefix}${order?.id || ''}`,
      ref2: settings.payment_qr_ref2,
    });
  }

  if (type !== 'promptpay') throw new Error(`Unsupported payment QR type: ${type}`);
  return buildPromptPayPayload(settings.payment_qr_id, amount);
}

function paymentQrMeta(order, settings = {}) {
  const payload = buildPaymentQrPayload(order, settings);
  if (!payload) return null;
  return {
    payload,
    type: settings.payment_qr_type || 'promptpay',
    label: settings.payment_qr_label || 'สแกนจ่ายเงิน',
    accountName: settings.payment_qr_account_name || '',
    accountId: settings.payment_qr_type === 'raw' ? '' : digitsOnly(settings.payment_qr_id),
    includeAmount: settings.payment_qr_include_amount !== false,
  };
}

function assertValidPaymentQrSettings(settings = {}) {
  if (!settings.payment_qr_enabled) return;
  const fakeOrder = { id: 1, total_amount: 1 };
  buildPaymentQrPayload(fakeOrder, settings);
}

module.exports = {
  buildPromptPayPayload,
  buildThaiQrMerchantPayload,
  buildPaymentQrPayload,
  paymentQrMeta,
  assertValidPaymentQrSettings,
  crc16CcittFalse,
};

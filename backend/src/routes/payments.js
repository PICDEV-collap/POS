const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { loadOrder } = require('./orders');
const { loadSettings } = require('./settings');
const { emit } = require('../socket');
const logger = require('../lib/logger');

const router = express.Router();

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

function eventIdFor(provider, body, reference, amount, status) {
  const explicit = firstValue(
    body.provider_event_id,
    body.event_id,
    body.transaction_id,
    body.txn_id,
    body.payment_id,
    body.charge_id,
    body.id,
    body.data?.id,
    body.payment?.id
  );
  if (explicit) return String(explicit).slice(0, 200);
  const stable = JSON.stringify({
    reference,
    amount,
    status,
    paid_at: firstValue(body.paid_at, body.confirmed_at, body.transaction_time),
  });
  return `fallback:${crypto.createHash('sha256').update(`${provider}:${stable}`).digest('hex')}`;
}

function normalizeStatus(body) {
  const raw = String(
    firstValue(
      body.status,
      body.payment_status,
      body.transaction_status,
      body.event,
      body.data?.status,
      body.payment?.status
    ) || ''
  ).toLowerCase();
  if (body.paid === true || body.success === true || body.confirmed === true) return 'confirmed';
  if (['paid', 'success', 'succeeded', 'confirmed', 'settled', 'completed', 'approved'].includes(raw)) {
    return 'confirmed';
  }
  if (['refund', 'refunded'].includes(raw)) return 'refunded';
  if (['fail', 'failed', 'cancel', 'cancelled', 'canceled', 'void', 'voided', 'rejected'].includes(raw)) {
    return 'failed';
  }
  return 'pending';
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

function amountFromBody(body) {
  return normalizeAmount(firstValue(
    body.amount,
    body.paid_amount,
    body.total_amount,
    body.transaction_amount,
    body.data?.amount,
    body.payment?.amount
  ));
}

function referenceFromBody(body) {
  return firstValue(
    body.reference,
    body.ref,
    body.ref1,
    body.ref_1,
    body.bill_ref1,
    body.billPaymentRef1,
    body.order_ref,
    body.order_reference,
    body.data?.reference,
    body.payment?.reference
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function orderIdFromReference(reference, settings) {
  const direct = Number.parseInt(String(reference || '').trim(), 10);
  if (Number.isInteger(direct) && direct > 0 && String(direct) === String(reference).trim()) {
    return direct;
  }
  const prefix = settings?.payment_qr_ref1_prefix || 'ORDER';
  const match = String(reference || '').trim().match(new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`, 'i'));
  if (match) return Number.parseInt(match[1], 10);
  const loose = String(reference || '').trim().match(/(?:ORDER|#)(\d+)/i);
  return loose ? Number.parseInt(loose[1], 10) : null;
}

function assertWebhookSecret(req) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!expected) {
    const err = new Error('PAYMENT_WEBHOOK_SECRET is not configured');
    err.status = 503;
    throw err;
  }
  const provided = String(req.get('x-pos-payment-secret') || req.get('x-payment-secret') || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('invalid payment webhook secret');
    err.status = 401;
    throw err;
  }
}

async function recordPaymentConfirmation({
  provider,
  body,
  createdBy = null,
  source = 'webhook',
}) {
  const settings = await loadSettings();
  const reference = referenceFromBody(body);
  const orderId = Number.parseInt(firstValue(body.order_id, body.orderId, body.metadata?.order_id), 10)
    || orderIdFromReference(reference, settings);
  if (!orderId) {
    const err = new Error('order reference not found');
    err.status = 400;
    throw err;
  }

  const incomingStatus = normalizeStatus(body);
  const amount = amountFromBody(body);
  const providerEventId = eventIdFor(provider, body, reference, amount, incomingStatus);
  const rawPayload = safeJson(body);

  const client = await db.getClient();
  let orderChanged = false;
  let txRow;
  let order;
  try {
    await client.query('BEGIN');
    const orderRows = await client.query(
      'SELECT id, status, total_amount FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    order = orderRows.rows[0];
    if (!order) {
      const err = new Error('order not found');
      err.status = 404;
      throw err;
    }

    let finalStatus = incomingStatus;
    let error = null;
    if (incomingStatus === 'confirmed' && amount !== null) {
      const expected = Number(order.total_amount);
      if (Math.abs(expected - amount) > 0.01) {
        finalStatus = 'rejected';
        error = `amount_mismatch expected=${expected.toFixed(2)} actual=${amount.toFixed(2)}`;
      }
    }
    if (incomingStatus === 'confirmed' && order.status === 'cancelled') {
      finalStatus = 'rejected';
      error = 'order_cancelled';
    }

    const inserted = await client.query(
      `INSERT INTO payment_transactions
         (order_id, provider, provider_event_id, reference, amount, currency,
          status, raw_payload, error, confirmed_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8::jsonb, $9,
               CASE WHEN $7::varchar = 'confirmed' THEN NOW() ELSE NULL END, $10)
       ON CONFLICT (provider, provider_event_id) DO UPDATE
          SET order_id = COALESCE(payment_transactions.order_id, EXCLUDED.order_id),
              reference = COALESCE(payment_transactions.reference, EXCLUDED.reference),
              amount = COALESCE(payment_transactions.amount, EXCLUDED.amount),
              status = CASE
                         WHEN payment_transactions.status = 'confirmed' THEN payment_transactions.status
                         ELSE EXCLUDED.status
                       END,
              raw_payload = EXCLUDED.raw_payload,
              error = EXCLUDED.error,
              confirmed_at = CASE
                               WHEN payment_transactions.confirmed_at IS NOT NULL THEN payment_transactions.confirmed_at
                               WHEN EXCLUDED.status = 'confirmed' THEN NOW()
                               ELSE NULL
                             END,
              updated_at = NOW()
       RETURNING *`,
      [
        order.id,
        provider,
        providerEventId,
        reference ? String(reference).slice(0, 200) : null,
        amount,
        String(firstValue(body.currency, body.data?.currency, body.payment?.currency, 'THB')).slice(0, 8),
        finalStatus,
        JSON.stringify(rawPayload),
        error,
        createdBy,
      ]
    );
    txRow = inserted.rows[0];

    const autoClose = settings.payment_auto_close_enabled !== false;
    if (autoClose && txRow.status === 'confirmed' && order.status !== 'paid') {
      const updated = await client.query(
        `UPDATE orders
            SET status = 'paid',
                updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('paid', 'cancelled')
          RETURNING id`,
        [order.id]
      );
      orderChanged = !!updated.rows[0];
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (orderChanged) {
    const fullOrder = await loadOrder(order.id);
    emit('order:update', fullOrder);
    logger.info('payment.auto_close', 'order marked paid from payment confirmation', {
      order_id: order.id,
      provider,
      provider_event_id: providerEventId,
      transaction_id: txRow.id,
      source,
    });
  } else {
    logger.info('payment.confirmation', 'payment recorded without order status change', {
      order_id: order.id,
      order_status: order.status,
      payment_status: txRow.status,
      provider,
      provider_event_id: providerEventId,
      transaction_id: txRow.id,
      source,
    });
  }

  return {
    ok: true,
    auto_closed: orderChanged,
    order_id: order.id,
    payment: {
      id: txRow.id,
      provider: txRow.provider,
      provider_event_id: txRow.provider_event_id,
      reference: txRow.reference,
      amount: txRow.amount,
      status: txRow.status,
      error: txRow.error,
    },
  };
}

router.post('/webhook/:provider', async (req, res, next) => {
  try {
    assertWebhookSecret(req);
    const provider = String(req.params.provider || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    const result = await recordPaymentConfirmation({
      provider,
      body: req.body || {},
      source: 'webhook',
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/confirm', authRequired, requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const result = await recordPaymentConfirmation({
      provider: String(req.body?.provider || 'manual').slice(0, 32),
      body: {
        ...req.body,
        status: 'confirmed',
        provider_event_id: firstValue(
          req.body?.provider_event_id,
          req.body?.transaction_id,
          `manual:${req.user.sub}:${Date.now()}`
        ),
      },
      createdBy: req.user.sub,
      source: 'manual',
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/order/:id', authRequired, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, order_id, provider, provider_event_id, reference, amount,
            currency, status, error, confirmed_at, created_at, updated_at
       FROM payment_transactions
      WHERE order_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

module.exports = { router, recordPaymentConfirmation };

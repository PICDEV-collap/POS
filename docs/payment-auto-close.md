# Payment Auto Close

## What This Does

The POS can automatically mark an order as `paid` only after a trusted payment confirmation is received.

Scanning a PromptPay/static Thai QR code does not notify the POS by itself. A payment gateway, bank webhook, slip verification service, or staff/admin confirmation must call the payment API.

## Webhook Endpoint

```http
POST /api/payments/webhook/:provider
Content-Type: application/json
x-pos-payment-secret: <PAYMENT_WEBHOOK_SECRET>
```

The secret is configured in `backend/.env` as `PAYMENT_WEBHOOK_SECRET`.

Example payload:

```json
{
  "order_id": 45,
  "reference": "ORDER45",
  "amount": 150.00,
  "status": "paid",
  "transaction_id": "bank-or-gateway-event-id"
}
```

Accepted paid statuses:

```text
paid, success, succeeded, confirmed, settled, completed, approved
```

The backend validates:

- webhook secret
- order exists
- amount matches `orders.total_amount` when amount is supplied
- cancelled orders are not auto-closed
- duplicate webhook events are idempotent by `(provider, provider_event_id)`

When valid and `payment_auto_close_enabled = true`, the order is updated to:

```text
orders.status = paid
```

Then the backend emits:

```text
order:update
```

## Manual Confirmation Endpoint

For staff/admin after verifying a slip:

```http
POST /api/payments/confirm
Authorization: Bearer <staff-or-admin-token>
Content-Type: application/json
```

```json
{
  "order_id": 45,
  "amount": 150.00,
  "reference": "ORDER45",
  "transaction_id": "manual-slip-id"
}
```

## Diagnostics

List recorded payments for an order:

```http
GET /api/payments/order/:orderId
Authorization: Bearer <token>
```

Important log scopes:

```text
payment.auto_close
payment.confirmation
```

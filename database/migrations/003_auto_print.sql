-- Migration 003 — auto-print toggles per restaurant
--
-- When `auto_print_kitchen=true`, the backend enqueues a kitchen receipt
-- automatically every time createOrder() succeeds (whether the order came
-- from a customer QR scan or a staff-placed order). The mobile BLE auto-
-- print path reads the same flag via /api/settings.
--
-- `auto_print_receipt` does the same for the customer receipt — usually OFF
-- because most flows want to print the receipt only when the order is paid.
--
-- Idempotent.

ALTER TABLE restaurant_settings
    ADD COLUMN IF NOT EXISTS auto_print_kitchen BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE restaurant_settings
    ADD COLUMN IF NOT EXISTS auto_print_receipt BOOLEAN NOT NULL DEFAULT FALSE;

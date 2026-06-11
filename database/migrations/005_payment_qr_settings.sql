ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS payment_qr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_qr_type VARCHAR(24) NOT NULL DEFAULT 'promptpay',
  ADD COLUMN IF NOT EXISTS payment_qr_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_raw_payload TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_account_name TEXT,
  ADD COLUMN IF NOT EXISTS payment_qr_label TEXT NOT NULL DEFAULT 'สแกนจ่ายเงิน',
  ADD COLUMN IF NOT EXISTS payment_qr_include_amount BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS payment_qr_ref1_prefix VARCHAR(12) NOT NULL DEFAULT 'ORDER',
  ADD COLUMN IF NOT EXISTS payment_qr_ref2 VARCHAR(20);

UPDATE restaurant_settings
   SET payment_qr_type = COALESCE(NULLIF(payment_qr_type, ''), 'promptpay'),
       payment_qr_label = COALESCE(NULLIF(payment_qr_label, ''), 'สแกนจ่ายเงิน'),
       payment_qr_ref1_prefix = COALESCE(NULLIF(payment_qr_ref1_prefix, ''), 'ORDER')
 WHERE id = 1;

-- Ensure every store has enough starter data to be managed immediately:
-- table QR points for kiosk ordering and basic menu categories.
-- Idempotent and additive only; existing store data is preserved.

DO $$
DECLARE
  s RECORD;
BEGIN
  FOR s IN SELECT id FROM stores LOOP
    INSERT INTO tables (store_id, code, name, seats, qr_token, is_active)
    SELECT s.id, v.code, v.name, v.seats, encode(gen_random_bytes(16), 'hex'), TRUE
      FROM (VALUES
        ('A1', 'โต๊ะ 1', 4),
        ('A2', 'โต๊ะ 2', 4),
        ('A3', 'โต๊ะ 3', 4),
        ('A4', 'โต๊ะ 4', 4),
        ('TAKEAWAY', 'สั่งกลับบ้าน', 0)
      ) AS v(code, name, seats)
     WHERE NOT EXISTS (
       SELECT 1
         FROM tables t
        WHERE t.store_id = s.id
          AND lower(t.code) = lower(v.code)
     );

    IF NOT EXISTS (SELECT 1 FROM categories c WHERE c.store_id = s.id) THEN
      INSERT INTO categories (store_id, name, icon, sort_order, is_active)
      VALUES
        (s.id, 'อาหาร', '🍽️', 10, TRUE),
        (s.id, 'เครื่องดื่ม', '🥤', 20, TRUE);
    END IF;
  END LOOP;
END $$;

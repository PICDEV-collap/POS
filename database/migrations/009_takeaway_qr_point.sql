INSERT INTO tables (code, name, seats, qr_token, is_active)
VALUES ('TAKEAWAY', 'สั่งกลับบ้าน', 0, encode(gen_random_bytes(16), 'hex'), TRUE)
ON CONFLICT (code) DO UPDATE
   SET name = 'สั่งกลับบ้าน',
       seats = 0,
       is_active = TRUE;

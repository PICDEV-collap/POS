-- Non-user seed data. Users are created by `npm run db:seed` in backend
-- so their passwords are hashed properly with bcrypt.

INSERT INTO tables (store_id, code, name, seats, qr_token) VALUES
(1, 'A1', 'โต๊ะ A1', 4, encode(gen_random_bytes(16), 'hex')),
(1, 'A2', 'โต๊ะ A2', 4, encode(gen_random_bytes(16), 'hex')),
(1, 'A3', 'โต๊ะ A3', 2, encode(gen_random_bytes(16), 'hex')),
(1, 'B1', 'โต๊ะ B1', 6, encode(gen_random_bytes(16), 'hex')),
(1, 'B2', 'โต๊ะ B2', 6, encode(gen_random_bytes(16), 'hex')),
(1, 'TAKEAWAY', 'สั่งกลับบ้าน', 0, encode(gen_random_bytes(16), 'hex'));

INSERT INTO categories (store_id, name, sort_order) VALUES
(1, 'เครื่องดื่ม',    1),
(1, 'อาหารทานเล่น',  2),
(1, 'จานหลัก',       3),
(1, 'ของหวาน',       4);

INSERT INTO products (store_id, category_id, name, description, price, sort_order) VALUES
(1, 1, 'น้ำเปล่า',         'ขวด 600ml',                  15.00, 1),
(1, 1, 'ชาเย็น',           'ชาไทยใส่นม',                 35.00, 2),
(1, 1, 'กาแฟเย็น',         'กาแฟสดใส่นม',                45.00, 3),
(1, 2, 'ปอเปี๊ยะทอด',     '5 ชิ้น เสิร์ฟพร้อมน้ำจิ้ม', 60.00, 1),
(1, 2, 'ไก่ทอด',           '4 ชิ้น',                     80.00, 2),
(1, 3, 'ข้าวผัดกระเพราไก่', 'ใส่ไข่ดาว',                  70.00, 1),
(1, 3, 'ผัดไทย',           'กุ้งสด ใส่ไข่',              85.00, 2),
(1, 3, 'ต้มยำกุ้ง',         'ใหญ่/เล็ก',                  150.00, 3),
(1, 4, 'ไอศกรีมกะทิ',      '2 ลูก',                      45.00, 1),
(1, 4, 'ขนมหวานรวม',       '',                            55.00, 2);

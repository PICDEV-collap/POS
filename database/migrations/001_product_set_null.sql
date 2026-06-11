-- Migration 001 — allow hard-deleting products
--
-- Before: order_items.product_id is NOT NULL with FK RESTRICT (default).
-- That means DELETE FROM products WHERE id=X fails the moment any order has
-- ever included that product. We had to silently soft-delete (set
-- is_available=false) and the admin's "ลบ" button felt broken — items just
-- went gray instead of disappearing.
--
-- After: order_items.product_id is NULLABLE with FK SET NULL. The historical
-- order rows still have `product_name` and `unit_price` snapshot columns,
-- so receipts and reports keep showing the right name+price even after the
-- product row is gone. The only thing lost is the *pointer* to a now-deleted
-- product, which is fine.
--
-- Idempotent — safe to re-run.

ALTER TABLE order_items
    DROP CONSTRAINT IF EXISTS order_items_product_id_fkey;

ALTER TABLE order_items
    ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE order_items
    ADD CONSTRAINT order_items_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;

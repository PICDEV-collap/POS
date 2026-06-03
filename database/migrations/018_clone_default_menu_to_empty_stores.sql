-- Give existing newly-created stores a usable QR ordering menu.
-- Only stores with zero products are backfilled; stores with their own menu are untouched.

DO $$
DECLARE
  target_store RECORD;
  source_store_id INT := 1;
BEGIN
  FOR target_store IN
    SELECT s.id
      FROM stores s
     WHERE s.id <> source_store_id
       AND NOT EXISTS (
         SELECT 1 FROM products p WHERE p.store_id = s.id
       )
  LOOP
    INSERT INTO categories (store_id, name, icon, sort_order, is_active)
    SELECT target_store.id, src.name, src.icon, src.sort_order, src.is_active
      FROM categories src
     WHERE src.store_id = source_store_id
       AND NOT EXISTS (
         SELECT 1
           FROM categories dst
          WHERE dst.store_id = target_store.id
            AND lower(dst.name) = lower(src.name)
       )
     ORDER BY src.sort_order, src.id;

    INSERT INTO products
      (store_id, category_id, name, description, price, image_url, is_available,
       sort_order, emoji, is_popular, options, variants, cost_price, product_type,
       barcode, track_stock, stock_qty, stock_alert_qty, print_station_key)
    SELECT target_store.id,
           dst_cat.id,
           src.name,
           src.description,
           src.price,
           src.image_url,
           src.is_available,
           src.sort_order,
           src.emoji,
           src.is_popular,
           src.options,
           src.variants,
           src.cost_price,
           src.product_type,
           NULL,
           src.track_stock,
           src.stock_qty,
           src.stock_alert_qty,
           src.print_station_key
      FROM products src
      LEFT JOIN categories src_cat ON src_cat.id = src.category_id
      LEFT JOIN categories dst_cat
        ON dst_cat.store_id = target_store.id
       AND lower(dst_cat.name) = lower(src_cat.name)
     WHERE src.store_id = source_store_id
     ORDER BY src.sort_order, src.id;
  END LOOP;
END $$;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_require_gps BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_shop_lat DOUBLE PRECISION;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_shop_lng DOUBLE PRECISION;

ALTER TABLE restaurant_settings
  ADD COLUMN IF NOT EXISTS ordering_max_distance_m INT NOT NULL DEFAULT 20;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_settings_ordering_shop_lat'
  ) THEN
    ALTER TABLE restaurant_settings
      ADD CONSTRAINT chk_restaurant_settings_ordering_shop_lat
      CHECK (ordering_shop_lat IS NULL OR (ordering_shop_lat >= -90 AND ordering_shop_lat <= 90));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_settings_ordering_shop_lng'
  ) THEN
    ALTER TABLE restaurant_settings
      ADD CONSTRAINT chk_restaurant_settings_ordering_shop_lng
      CHECK (ordering_shop_lng IS NULL OR (ordering_shop_lng >= -180 AND ordering_shop_lng <= 180));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_restaurant_settings_ordering_max_distance_m'
  ) THEN
    ALTER TABLE restaurant_settings
      ADD CONSTRAINT chk_restaurant_settings_ordering_max_distance_m
      CHECK (ordering_max_distance_m BETWEEN 1 AND 10000);
  END IF;
END $$;

UPDATE restaurant_settings
   SET ordering_max_distance_m = 20
 WHERE id = 1
   AND (ordering_max_distance_m IS NULL OR ordering_max_distance_m <= 0);

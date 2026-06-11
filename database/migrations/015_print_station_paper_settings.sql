-- Migration 015 — configurable paper profile per print station.
-- Backward compatible:
-- - Existing stations keep host/port/render settings.
-- - Missing station values still fall back to backend .env defaults.
-- - Adds a receipt station so USB/WiFi print-server receipt paper can be tuned from web admin.

ALTER TABLE print_stations
    ADD COLUMN IF NOT EXISTS paper_width_mm INT NOT NULL DEFAULT 58,
    ADD COLUMN IF NOT EXISTS paper_height_mm INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS paper_gap_mm INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS width_px INT NOT NULL DEFAULT 384,
    ADD COLUMN IF NOT EXISTS feed_lines INT NOT NULL DEFAULT 6,
    ADD COLUMN IF NOT EXISTS bottom_feed_px INT NOT NULL DEFAULT 160,
    ADD COLUMN IF NOT EXISTS raster_band_height INT NOT NULL DEFAULT 128,
    ADD COLUMN IF NOT EXISTS cut_mode VARCHAR(16) NOT NULL DEFAULT 'partial';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'print_stations_cut_mode_check'
      AND conrelid = 'print_stations'::regclass
  ) THEN
    ALTER TABLE print_stations
      ADD CONSTRAINT print_stations_cut_mode_check
      CHECK (cut_mode IN ('none', 'partial', 'full'));
  END IF;
END $$;

INSERT INTO print_stations
    (key, name, station_type, sort_order, width_chars, thai_cp, render_mode,
     paper_width_mm, paper_height_mm, paper_gap_mm, width_px,
     feed_lines, bottom_feed_px, raster_band_height, cut_mode)
VALUES
    ('receipt', 'ใบเสร็จ / แคชเชียร์', 'receipt', 40, 42, 21, 'image',
     58, 0, 0, 384, 6, 160, 128, 'full')
ON CONFLICT (key) DO NOTHING;

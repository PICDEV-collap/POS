-- Migration 004 — menu normalization + realtime/print reliability hardening
--
-- Idempotent and backward compatible:
-- - keeps products.options/products.variants JSONB for old mobile/web clients
-- - adds normalized menu tables for admin editing and future reporting
-- - migrates print queue states to pending/processing/success/failed/retrying/cancelled
-- - adds queue locking, dedupe keys, printer health, websocket sessions, and event replay

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Normalized menu schema ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_variants (
    id           SERIAL PRIMARY KEY,
    product_id   INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    external_id  VARCHAR(64),
    name         VARCHAR(128) NOT NULL,
    price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    sort_order   INT NOT NULL DEFAULT 0,
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_variants_product_name
    ON menu_variants (product_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_menu_variants_product_sort
    ON menu_variants (product_id, sort_order, id);

CREATE TABLE IF NOT EXISTS option_groups (
    id            SERIAL PRIMARY KEY,
    product_id    INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    external_id   VARCHAR(64),
    name          VARCHAR(128) NOT NULL,
    group_type    VARCHAR(16) NOT NULL DEFAULT 'single'
                  CHECK (group_type IN ('single', 'multiple')),
    is_required   BOOLEAN NOT NULL DEFAULT TRUE,
    min_select    INT NOT NULL DEFAULT 1 CHECK (min_select >= 0),
    max_select    INT NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    visible_when  JSONB,
    sort_order    INT NOT NULL DEFAULT 0,
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (max_select >= min_select)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_groups_product_name
    ON option_groups (product_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_option_groups_product_sort
    ON option_groups (product_id, sort_order, id);

CREATE TABLE IF NOT EXISTS option_items (
    id            SERIAL PRIMARY KEY,
    group_id      INT NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
    external_id   VARCHAR(64),
    name          VARCHAR(128) NOT NULL,
    price_delta   NUMERIC(10,2) NOT NULL DEFAULT 0,
    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 0,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_items_group_name
    ON option_items (group_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_option_items_group_sort
    ON option_items (group_id, sort_order, id);

-- Backfill variants from products.variants JSONB.
INSERT INTO menu_variants (product_id, external_id, name, price, sort_order, is_default, is_available)
SELECT p.id,
       COALESCE(NULLIF(v.obj ->> 'id', ''), 'variant_' || md5(p.id::text || ':' || (v.obj ->> 'name'))),
       v.obj ->> 'name',
       CASE
         WHEN (v.obj ->> 'price') ~ '^\d+(\.\d+)?$' THEN (v.obj ->> 'price')::numeric(10,2)
         ELSE p.price
       END,
       (v.ord - 1)::int,
       CASE WHEN lower(COALESCE(v.obj ->> 'is_default', 'false')) IN ('true', '1', 'yes', 'on') THEN TRUE ELSE FALSE END,
       CASE WHEN lower(COALESCE(v.obj ->> 'is_available', 'true')) IN ('false', '0', 'no', 'off') THEN FALSE ELSE TRUE END
  FROM products p
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(p.variants) = 'array' THEN p.variants ELSE '[]'::jsonb END
 ) WITH ORDINALITY AS v(obj, ord)
 WHERE p.variants IS NOT NULL
   AND jsonb_typeof(v.obj) = 'object'
   AND NULLIF(v.obj ->> 'name', '') IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM menu_variants mv
        WHERE mv.product_id = p.id AND lower(mv.name) = lower(v.obj ->> 'name')
   );

-- Backfill groups from products.options JSONB.
INSERT INTO option_groups
    (product_id, external_id, name, group_type, is_required, min_select, max_select,
     visible_when, sort_order, is_available)
SELECT p.id,
       COALESCE(NULLIF(g.obj ->> 'id', ''), 'group_' || md5(p.id::text || ':' || (g.obj ->> 'name'))),
       g.obj ->> 'name',
       CASE
         WHEN lower(COALESCE(g.obj ->> 'type', g.obj ->> 'selection_type', 'single')) IN ('multiple', 'multi')
              OR lower(COALESCE(g.obj ->> 'mutex', 'true')) = 'false'
           THEN 'multiple'
         ELSE 'single'
       END,
       CASE
         WHEN lower(COALESCE(g.obj ->> 'required', g.obj ->> 'is_required', 'true')) IN ('false', '0', 'no', 'off') THEN FALSE
         ELSE TRUE
       END,
       CASE
         WHEN (g.obj ->> 'min_select') ~ '^\d+$' THEN (g.obj ->> 'min_select')::int
         WHEN (g.obj ->> 'min') ~ '^\d+$' THEN (g.obj ->> 'min')::int
         WHEN lower(COALESCE(g.obj ->> 'required', g.obj ->> 'is_required', 'true')) IN ('false', '0', 'no', 'off') THEN 0
         ELSE 1
       END,
       CASE
         WHEN lower(COALESCE(g.obj ->> 'type', g.obj ->> 'selection_type', 'single')) IN ('multiple', 'multi')
              OR lower(COALESCE(g.obj ->> 'mutex', 'true')) = 'false'
           THEN GREATEST(1, COALESCE(
             NULLIF(jsonb_array_length(
               CASE
                 WHEN jsonb_typeof(g.obj -> 'items') = 'array' THEN g.obj -> 'items'
                 WHEN jsonb_typeof(g.obj -> 'choices') = 'array' THEN g.obj -> 'choices'
                 ELSE '[]'::jsonb
               END
             ), 0), 1))
         ELSE 1
       END,
       CASE
         WHEN jsonb_typeof(g.obj -> 'visible_when') = 'object' THEN g.obj -> 'visible_when'
         ELSE NULL
       END,
       (g.ord - 1)::int,
       CASE
         WHEN lower(COALESCE(g.obj ->> 'is_available', 'true')) IN ('false', '0', 'no', 'off') THEN FALSE
         ELSE TRUE
       END
  FROM products p
 CROSS JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(p.options) = 'array' THEN p.options ELSE '[]'::jsonb END
 ) WITH ORDINALITY AS g(obj, ord)
 WHERE p.options IS NOT NULL
   AND jsonb_typeof(g.obj) = 'object'
   AND NULLIF(g.obj ->> 'name', '') IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM option_groups og
        WHERE og.product_id = p.id AND lower(og.name) = lower(g.obj ->> 'name')
   );

-- Backfill option items from group.items or legacy group.choices.
WITH raw_groups AS (
  SELECT p.id AS product_id,
         g.obj AS group_obj,
         g.obj ->> 'name' AS group_name
    FROM products p
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(p.options) = 'array' THEN p.options ELSE '[]'::jsonb END
   ) WITH ORDINALITY AS g(obj, ord)
   WHERE p.options IS NOT NULL
     AND jsonb_typeof(g.obj) = 'object'
     AND NULLIF(g.obj ->> 'name', '') IS NOT NULL
),
raw_items AS (
  SELECT rg.product_id,
         rg.group_name,
         item.obj AS item_obj,
         item.ord
    FROM raw_groups rg
   CROSS JOIN LATERAL jsonb_array_elements(
     CASE
       WHEN jsonb_typeof(rg.group_obj -> 'items') = 'array' THEN rg.group_obj -> 'items'
       WHEN jsonb_typeof(rg.group_obj -> 'choices') = 'array' THEN rg.group_obj -> 'choices'
       ELSE '[]'::jsonb
     END
   ) WITH ORDINALITY AS item(obj, ord)
),
clean_items AS (
  SELECT og.id AS group_id,
         CASE
           WHEN jsonb_typeof(ri.item_obj) = 'object' THEN ri.item_obj ->> 'name'
           ELSE trim(both '"' from ri.item_obj::text)
         END AS item_name,
         CASE
           WHEN jsonb_typeof(ri.item_obj) = 'object' AND (ri.item_obj ->> 'id') IS NOT NULL
             THEN ri.item_obj ->> 'id'
           ELSE NULL
         END AS external_id,
         CASE
           WHEN jsonb_typeof(ri.item_obj) = 'object' AND (ri.item_obj ->> 'price_delta') ~ '^-?\d+(\.\d+)?$'
             THEN (ri.item_obj ->> 'price_delta')::numeric(10,2)
           WHEN jsonb_typeof(ri.item_obj) = 'object' AND (ri.item_obj ->> 'extra_price') ~ '^-?\d+(\.\d+)?$'
             THEN (ri.item_obj ->> 'extra_price')::numeric(10,2)
           ELSE 0
         END AS price_delta,
         CASE
           WHEN jsonb_typeof(ri.item_obj) = 'object'
             THEN lower(COALESCE(ri.item_obj ->> 'is_default', 'false')) IN ('true', '1', 'yes', 'on')
           ELSE FALSE
         END AS is_default,
         CASE
           WHEN jsonb_typeof(ri.item_obj) = 'object'
             THEN lower(COALESCE(ri.item_obj ->> 'is_available', 'true')) NOT IN ('false', '0', 'no', 'off')
           ELSE TRUE
         END AS is_available,
         (ri.ord - 1)::int AS sort_order
    FROM raw_items ri
    JOIN option_groups og
      ON og.product_id = ri.product_id
     AND lower(og.name) = lower(ri.group_name)
)
INSERT INTO option_items
    (group_id, external_id, name, price_delta, is_default, is_available, sort_order)
SELECT group_id,
       COALESCE(NULLIF(external_id, ''), 'option_' || md5(group_id::text || ':' || item_name)),
       item_name,
       price_delta,
       is_default,
       is_available,
       sort_order
  FROM clean_items ci
 WHERE NULLIF(ci.item_name, '') IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM option_items oi
        WHERE oi.group_id = ci.group_id AND lower(oi.name) = lower(ci.item_name)
   );

-- ─── Print queue hardening ──────────────────────────────────────────────
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_uuid UUID;
UPDATE print_jobs SET job_uuid = gen_random_uuid() WHERE job_uuid IS NULL;
ALTER TABLE print_jobs ALTER COLUMN job_uuid SET DEFAULT gen_random_uuid();
ALTER TABLE print_jobs ALTER COLUMN job_uuid SET NOT NULL;

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS processing_deadline_at TIMESTAMPTZ;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(64);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_key VARCHAR(128);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_host TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_port INT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'print_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE print_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

UPDATE print_jobs
   SET status = CASE status
     WHEN 'queued' THEN 'pending'
     WHEN 'printing' THEN 'retrying'
     WHEN 'printed' THEN 'success'
     ELSE status
   END
 WHERE status IN ('queued', 'printing', 'printed');

ALTER TABLE print_jobs ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE print_jobs
    ADD CONSTRAINT print_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'retrying', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_print_jobs_due
    ON print_jobs (status, next_attempt_at, priority, created_at)
    WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_print_jobs_processing_deadline
    ON print_jobs (processing_deadline_at)
    WHERE status = 'processing';
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_dedupe_active
    ON print_jobs (dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS printer_status (
    id                   SERIAL PRIMARY KEY,
    printer_key           VARCHAR(128) UNIQUE NOT NULL,
    host                  TEXT,
    port                  INT,
    status                VARCHAR(16) NOT NULL DEFAULT 'unknown'
                          CHECK (status IN ('unknown', 'online', 'offline', 'unconfigured')),
    last_seen_at          TIMESTAMPTZ,
    last_error            TEXT,
    last_error_code       VARCHAR(64),
    last_latency_ms       INT,
    consecutive_failures  INT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_printer_status_state ON printer_status (status, updated_at);

-- ─── Websocket sessions + replay log ────────────────────────────────────
CREATE TABLE IF NOT EXISTS websocket_sessions (
    session_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id      TEXT,
    socket_id      TEXT,
    user_agent     TEXT,
    ip_address     TEXT,
    connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMPTZ,
    last_event_id  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_websocket_sessions_client
    ON websocket_sessions (client_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS realtime_events (
    id          BIGSERIAL PRIMARY KEY,
    event_name  VARCHAR(128) NOT NULL,
    room        VARCHAR(128),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_realtime_events_replay
    ON realtime_events (id, expires_at);

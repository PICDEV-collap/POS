-- POS_V2 Database Schema (PostgreSQL)
-- Encoding must be UTF-8 to support Thai characters.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS push_subscriptions CASCADE;
DROP TABLE IF EXISTS realtime_events CASCADE;
DROP TABLE IF EXISTS websocket_sessions CASCADE;
DROP TABLE IF EXISTS printer_status CASCADE;
DROP TABLE IF EXISTS print_jobs CASCADE;
DROP TABLE IF EXISTS payment_transactions CASCADE;
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS customer_order_sessions CASCADE;
DROP TABLE IF EXISTS option_items CASCADE;
DROP TABLE IF EXISTS option_groups CASCADE;
DROP TABLE IF EXISTS menu_variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS print_stations CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS tables CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
    id           SERIAL PRIMARY KEY,
    username     VARCHAR(64) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name    VARCHAR(128),
    role         VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'staff', 'kitchen')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tables (
    id         SERIAL PRIMARY KEY,
    code       VARCHAR(16) UNIQUE NOT NULL,        -- "A1", "B2" used in QR URL
    name       VARCHAR(64) NOT NULL,
    seats      INT DEFAULT 4,
    qr_token   VARCHAR(64) UNIQUE NOT NULL,        -- random token; rotate to invalidate
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customer_order_sessions (
    id              BIGSERIAL PRIMARY KEY,
    session_token   VARCHAR(96) UNIQUE NOT NULL,
    table_id        INT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    customer_key    VARCHAR(96) NOT NULL,
    first_ip        VARCHAR(64),
    last_ip         VARCHAR(64),
    user_agent_hash VARCHAR(64),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX idx_customer_order_sessions_table ON customer_order_sessions (table_id, last_seen_at DESC);
CREATE INDEX idx_customer_order_sessions_key ON customer_order_sessions (customer_key, expires_at DESC) WHERE is_active = TRUE;
CREATE INDEX idx_customer_order_sessions_expiry ON customer_order_sessions (expires_at) WHERE is_active = TRUE;

CREATE TABLE categories (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(64) NOT NULL,
    icon       VARCHAR(8),                       -- emoji
    sort_order INT NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE print_stations (
    key          VARCHAR(32) PRIMARY KEY,
    name         VARCHAR(128) NOT NULL,
    station_type VARCHAR(16) NOT NULL DEFAULT 'kitchen'
                 CHECK (station_type IN ('kitchen', 'drink', 'snack', 'receipt', 'custom')),
    printer_key  VARCHAR(128),
    printer_host TEXT,
    printer_port INT,
    width_chars  INT NOT NULL DEFAULT 42,
    thai_cp      INT NOT NULL DEFAULT 21,
    render_mode  VARCHAR(16) NOT NULL DEFAULT 'text'
                 CHECK (render_mode IN ('text', 'image')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    category_id INT REFERENCES categories(id) ON DELETE SET NULL,
    name        VARCHAR(128) NOT NULL,
    description TEXT,
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    cost_price  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    image_url   TEXT,
    emoji       VARCHAR(8),                      -- e.g. '🍜'
    is_popular  BOOLEAN NOT NULL DEFAULT FALSE,
    -- options: array of mutex groups (each group = radio buttons for the customer)
    --   [{"name":"ประเภท","choices":["น้ำ","แห้ง"]},
    --    {"name":"ความเผ็ด","choices":["พริก","ไม่พริก"]}]
    options     JSONB,
    -- variants: price tiers (each becomes its own line item with its own price)
    --   [{"name":"พิเศษ","price":40}]
    variants    JSONB,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INT NOT NULL DEFAULT 0,
    product_type VARCHAR(16) NOT NULL DEFAULT 'food'
                 CHECK (product_type IN ('food', 'drink', 'stock')),
    barcode     VARCHAR(64),
    track_stock BOOLEAN NOT NULL DEFAULT FALSE,
    stock_qty   NUMERIC(12,3) NOT NULL DEFAULT 0,
    stock_alert_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
    print_station_key VARCHAR(32) REFERENCES print_stations(key) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE menu_variants (
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
CREATE UNIQUE INDEX idx_menu_variants_product_name ON menu_variants (product_id, lower(name));
CREATE INDEX idx_menu_variants_product_sort ON menu_variants (product_id, sort_order, id);

CREATE TABLE option_groups (
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
CREATE UNIQUE INDEX idx_option_groups_product_name ON option_groups (product_id, lower(name));
CREATE INDEX idx_option_groups_product_sort ON option_groups (product_id, sort_order, id);

CREATE TABLE option_items (
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
CREATE UNIQUE INDEX idx_option_items_group_name ON option_items (group_id, lower(name));
CREATE INDEX idx_option_items_group_sort ON option_items (group_id, sort_order, id);

CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    table_id      INT NOT NULL REFERENCES tables(id),
    business_date DATE NOT NULL,
    daily_seq     INT NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'cooking', 'served', 'paid', 'cancelled')),
    total_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
    note          TEXT,
    source        VARCHAR(16) NOT NULL DEFAULT 'customer'
                  CHECK (source IN ('customer', 'staff')),
    order_type    VARCHAR(16) NOT NULL DEFAULT 'dine-in'
                  CHECK (order_type IN ('dine-in', 'takeaway')),
    customer_name VARCHAR(64),
    customer_session_id BIGINT REFERENCES customer_order_sessions(id) ON DELETE SET NULL,
    created_by    INT REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_orders_business_date_daily_seq ON orders (business_date, daily_seq);
CREATE INDEX idx_orders_business_date_created_at ON orders (business_date, created_at, id);
CREATE INDEX idx_orders_customer_session ON orders (customer_session_id) WHERE customer_session_id IS NOT NULL;

CREATE TABLE order_daily_sequences (
    business_date DATE PRIMARY KEY,
    last_seq      INT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
    id            SERIAL PRIMARY KEY,
    order_id      INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    -- product_id may go null if admin hard-deletes the product. The snapshot
    -- columns below (product_name, unit_price) keep the order display intact.
    product_id    INT REFERENCES products(id) ON DELETE SET NULL,
    product_name  VARCHAR(128) NOT NULL,            -- snapshot at order time
    unit_price    NUMERIC(10,2) NOT NULL,           -- snapshot at order time
    cost_price_snapshot NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_price_snapshot >= 0),
    quantity      INT NOT NULL CHECK (quantity > 0),
    note          TEXT,
    option_label  VARCHAR(64),                      -- DEPRECATED: see options_selected
    -- options_selected: array of {group, value} the customer picked, e.g.
    --   [{"group":"ประเภท","value":"น้ำ"}, {"group":"ความเผ็ด","value":"พริก"}]
    options_selected JSONB,
    variant_name  VARCHAR(64),                      -- snapshot of selected variant
    fulfillment_type VARCHAR(16) NOT NULL DEFAULT 'dine-in'
                  CHECK (fulfillment_type IN ('dine-in', 'takeaway')),
    print_station_key VARCHAR(32),
    status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'cooking', 'served', 'cancelled'))
);
CREATE INDEX idx_order_items_fulfillment_type ON order_items (order_id, fulfillment_type);
CREATE INDEX idx_order_items_cost_report ON order_items (order_id, product_id);

CREATE TABLE stock_movements (
    id              SERIAL PRIMARY KEY,
    movement_key    TEXT UNIQUE NOT NULL,
    product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    order_id        INT REFERENCES orders(id) ON DELETE SET NULL,
    order_item_id   INT REFERENCES order_items(id) ON DELETE SET NULL,
    movement_type   VARCHAR(24) NOT NULL
                    CHECK (movement_type IN ('sale', 'cancel_order', 'cancel_item', 'manual_adjust')),
    quantity_delta  NUMERIC(12,3) NOT NULL,
    stock_after     NUMERIC(12,3),
    note            TEXT,
    created_by      INT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE restaurant_settings (
    id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    name        VARCHAR(128) NOT NULL DEFAULT 'POS V2 Restaurant',
    logo        VARCHAR(8) DEFAULT '🍽️',
    currency    VARCHAR(8) NOT NULL DEFAULT '฿',
    base_url    TEXT,
    -- When TRUE, every successful createOrder() auto-enqueues a kitchen
    -- receipt (so kitchen sees the print without staff pressing 🖨️).
    auto_print_kitchen BOOLEAN NOT NULL DEFAULT FALSE,
    -- Same idea but for the customer receipt — usually FALSE (printed when
    -- staff marks order as paid).
    auto_print_receipt BOOLEAN NOT NULL DEFAULT FALSE,
    payment_qr_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    payment_qr_type VARCHAR(24) NOT NULL DEFAULT 'promptpay',
    payment_qr_id TEXT,
    payment_qr_raw_payload TEXT,
    payment_qr_account_name TEXT,
    payment_qr_label TEXT NOT NULL DEFAULT 'สแกนจ่ายเงิน',
    payment_qr_include_amount BOOLEAN NOT NULL DEFAULT TRUE,
    payment_qr_ref1_prefix VARCHAR(12) NOT NULL DEFAULT 'ORDER',
    payment_qr_ref2 VARCHAR(20),
    payment_auto_close_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ordering_open_time TIME NOT NULL DEFAULT '00:00',
    ordering_close_time TIME NOT NULL DEFAULT '23:59',
    ordering_timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Bangkok',
    ordering_days INT[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::INT[],
    ordering_require_session BOOLEAN NOT NULL DEFAULT TRUE,
    ordering_require_private_ip BOOLEAN NOT NULL DEFAULT FALSE,
    ordering_require_gps BOOLEAN NOT NULL DEFAULT FALSE,
    ordering_shop_lat DOUBLE PRECISION CHECK (ordering_shop_lat IS NULL OR (ordering_shop_lat >= -90 AND ordering_shop_lat <= 90)),
    ordering_shop_lng DOUBLE PRECISION CHECK (ordering_shop_lng IS NULL OR (ordering_shop_lng >= -180 AND ordering_shop_lng <= 180)),
    ordering_max_distance_m INT NOT NULL DEFAULT 20 CHECK (ordering_max_distance_m BETWEEN 1 AND 10000),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO restaurant_settings (id) VALUES (1);

CREATE TABLE payment_transactions (
    id                SERIAL PRIMARY KEY,
    order_id          INT REFERENCES orders(id) ON DELETE SET NULL,
    provider          VARCHAR(32) NOT NULL DEFAULT 'manual',
    provider_event_id TEXT,
    reference         TEXT,
    amount            NUMERIC(10,2),
    currency          VARCHAR(8) NOT NULL DEFAULT 'THB',
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed', 'refunded')),
    raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error             TEXT,
    confirmed_at      TIMESTAMPTZ,
    created_by        INT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_event_id)
);
CREATE INDEX idx_payment_transactions_order ON payment_transactions(order_id, created_at DESC);
CREATE INDEX idx_payment_transactions_reference ON payment_transactions(provider, reference);
CREATE INDEX idx_payment_transactions_status ON payment_transactions(status, created_at DESC);

CREATE TABLE accounting_exports (
    id           SERIAL PRIMARY KEY,
    export_type  VARCHAR(32) NOT NULL,
    from_date    DATE NOT NULL,
    to_date      DATE NOT NULL,
    row_count    INT NOT NULL DEFAULT 0,
    created_by   INT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accounting_exports_created ON accounting_exports (created_at DESC);

CREATE TABLE print_jobs (
    id              SERIAL PRIMARY KEY,
    job_uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
    type            VARCHAR(16) NOT NULL CHECK (type IN ('kitchen', 'receipt', 'test', 'custom')),
    order_id        INT REFERENCES orders(id) ON DELETE SET NULL,
    label           VARCHAR(128),                      -- short human label, e.g. "Kitchen receipt #42"
    payload         BYTEA NOT NULL,                    -- pre-rendered ESC/POS bytes
    status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'retrying', 'cancelled')),
    dedupe_key      TEXT,
    priority        INT NOT NULL DEFAULT 0,
    attempts        INT NOT NULL DEFAULT 0,
    max_attempts    INT NOT NULL DEFAULT 8,
    error           TEXT,
    last_error_code VARCHAR(64),
    printer_key     VARCHAR(128),
    printer_host    TEXT,
    printer_port    INT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by       TEXT,
    locked_at       TIMESTAMPTZ,
    processing_deadline_at TIMESTAMPTZ,
    created_by      INT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    printed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_orders_status         ON orders(status);
CREATE INDEX idx_orders_table          ON orders(table_id);
CREATE INDEX idx_order_items_order     ON order_items(order_id);
CREATE INDEX idx_products_category     ON products(category_id);
CREATE UNIQUE INDEX idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE INDEX idx_products_print_station ON products(print_station_key);
CREATE INDEX idx_order_items_print_station ON order_items(order_id, print_station_key);
CREATE INDEX idx_stock_movements_product_created ON stock_movements(product_id, created_at DESC);
CREATE INDEX idx_stock_movements_order ON stock_movements(order_id, order_item_id);
CREATE INDEX idx_print_jobs_due        ON print_jobs(status, next_attempt_at, priority, created_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX idx_print_jobs_processing_deadline ON print_jobs(processing_deadline_at) WHERE status = 'processing';
CREATE UNIQUE INDEX idx_print_jobs_dedupe_active ON print_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'cancelled';
CREATE INDEX idx_print_jobs_order      ON print_jobs(order_id);

CREATE TABLE printer_status (
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
CREATE INDEX idx_printer_status_state ON printer_status(status, updated_at);

CREATE TABLE websocket_sessions (
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       TEXT,
    socket_id       TEXT,
    user_agent      TEXT,
    ip_address      TEXT,
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMPTZ,
    last_event_id   BIGINT
);
CREATE INDEX idx_websocket_sessions_client ON websocket_sessions(client_id, last_seen_at DESC);

CREATE TABLE realtime_events (
    id          BIGSERIAL PRIMARY KEY,
    event_name  VARCHAR(128) NOT NULL,
    room        VARCHAR(128),
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX idx_realtime_events_replay ON realtime_events(id, expires_at);

CREATE TABLE push_subscriptions (
    id           SERIAL PRIMARY KEY,
    user_id      INT REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    scope        VARCHAR(16) NOT NULL DEFAULT 'kitchen'
                 CHECK (scope IN ('kitchen','staff','admin','all')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_push_subs_scope ON push_subscriptions(scope);

-- Migration 002 — option groups
--
-- Before:
--   products.options    = JSONB array of plain strings, e.g. ["เผ็ด","ไม่เผ็ด"]
--                         (single flat list — no grouping, no mutex, dormant
--                         in the UI)
--   order_items.option_label = VARCHAR(64) — single string, also dormant
--
-- After:
--   products.options    = array of GROUPS, each group is mutex (radio):
--     [
--       {"name": "ประเภท",   "choices": ["น้ำ","แห้ง"]},
--       {"name": "ความเผ็ด", "choices": ["พริก","ไม่พริก"]}
--     ]
--   order_items.options_selected = JSONB snapshot of customer's pick:
--     [
--       {"group": "ประเภท",   "value": "น้ำ"},
--       {"group": "ความเผ็ด", "value": "พริก"}
--     ]
--
-- Idempotent — safe to re-run.

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS options_selected JSONB;

-- Convert legacy flat-string options into a single group called "ตัวเลือก".
-- Detect rows where options is an array whose first element is a string.
UPDATE products
   SET options = jsonb_build_array(
         jsonb_build_object('name', 'ตัวเลือก', 'choices', options)
       )
 WHERE options IS NOT NULL
   AND jsonb_typeof(options) = 'array'
   AND jsonb_array_length(options) > 0
   AND jsonb_typeof(options -> 0) = 'string';

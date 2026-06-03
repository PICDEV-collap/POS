-- Allow 'qr' as a print_jobs.type so staff can hand a paper QR to
-- customers (printed on the same thermal printer as receipts).
--
-- The original constraint allowed only ('kitchen','receipt','test','custom').
-- We drop any existing type-check constraint and recreate it with 'qr'
-- so the migration is safe to re-run on databases where the constraint
-- name may differ from the schema default.

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'print_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%type%IN%'
  LOOP
    EXECUTE format('ALTER TABLE print_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE print_jobs
    ADD CONSTRAINT print_jobs_type_check
    CHECK (type IN ('kitchen', 'receipt', 'test', 'custom', 'qr'));

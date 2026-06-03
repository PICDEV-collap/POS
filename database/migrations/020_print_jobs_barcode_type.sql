-- Allow 'barcode' as a print_jobs.type so admin/staff can print product
-- barcode labels through the same thermal queue as receipts/QR codes.

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
    CHECK (type IN ('kitchen', 'receipt', 'test', 'custom', 'qr', 'barcode'));

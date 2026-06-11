ALTER TABLE mobile_print_claims
  ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '15 minutes';

UPDATE mobile_print_claims
   SET expires_at = NOW() + INTERVAL '15 minutes',
       updated_at = NOW()
 WHERE status = 'claimed'
   AND expires_at < NOW() + INTERVAL '15 minutes';

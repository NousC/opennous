-- Every observation that KNOWS where it came from should say so.
--
-- deriveSourceRef(source, external_id) has always built `source://<source>/<external_id>`,
-- but most ingest paths never passed sourceRef through recordObservation, so the pointer
-- landed on a small fraction of the thousands of rows that had the external_id sitting in the next column.
-- resolveRaw() could not find raw we were already storing: the verification path was dark
-- for data we hold. That is the trust gap, and it was a missing string, not a missing feature.
--
-- Deterministic, idempotent, fills nulls only. Applied to prod 2026-09-10 (a few hundred → several thousand).

UPDATE observations
   SET source_ref = 'source://' || source || '/' || external_id
 WHERE source_ref IS NULL
   AND external_id IS NOT NULL
   AND source IS NOT NULL;

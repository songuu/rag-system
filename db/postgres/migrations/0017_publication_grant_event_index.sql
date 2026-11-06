-- Recovery repeatedly scans each operation from zero; a transaction may
-- commit an older sequence value after a later event has been observed.
create index publication_grant_events_operation_id_id_idx
  on public.publication_grant_events (operation_id, id);

-- Radium migration 001: document processing lifecycle
-- Run in the Supabase SQL editor (idempotent — safe to re-run).
--
-- Lifecycle: QUEUED -> PROCESSING -> INDEXED
-- Failures:  UPLOAD_FAILED | PROCESSING_FAILED | INDEXED_EMPTY

alter table public.user_pdfs
  add column if not exists status text not null default 'QUEUED';

alter table public.user_pdfs
  add column if not exists chunk_count integer;

alter table public.user_pdfs
  add column if not exists indexed_at timestamptz;

alter table public.user_pdfs
  add column if not exists error text;

-- Helpful indexes for workspace document lists and status polling.
create index if not exists user_pdfs_workspace_id_idx
  on public.user_pdfs (workspace_id);

create index if not exists user_pdfs_status_idx
  on public.user_pdfs (status);

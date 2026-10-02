-- Radium migration 003: limitation-first gap fields
-- Run in the Supabase SQL editor (idempotent — safe to re-run).
--
-- Stores the evidence chain per gap so the UI can defend WHY a gap was
-- identified instead of showing a bare "Gap: X":
--   limitation     — the unresolved limitation the gap follows from
--   reasoning      — one sentence: limitation → gap inference
--   evidence_level — EXPLICIT | STRONGLY_SUPPORTED | SUPPORTED_INFERENCE | SPECULATIVE
--   verification   — verified (contradiction-screened) | unverified (screen skipped)

alter table public.research_gaps
  add column if not exists evidence_level text not null default 'SUPPORTED_INFERENCE';

alter table public.research_gaps
  add column if not exists verification text not null default 'unverified';

alter table public.research_gaps
  add column if not exists limitation text;

alter table public.research_gaps
  add column if not exists reasoning text;

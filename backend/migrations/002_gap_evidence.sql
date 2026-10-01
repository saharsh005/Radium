-- Radium migration 002: structured evidence for research gaps
-- Run in the Supabase SQL editor (idempotent — safe to re-run).
--
-- Stores the resolved supporting excerpts per gap so citations are
-- real file/page references instead of a blind first-N PDF list:
--   evidence = [{"ref":"E1","pdfId":"...","filename":"...","page":4,
--                "section":"...","quote":"..."}]

alter table public.research_gaps
  add column if not exists evidence jsonb not null default '[]'::jsonb;

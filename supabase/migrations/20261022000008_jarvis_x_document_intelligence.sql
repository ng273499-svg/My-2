-- =============================================================================
-- JARVIS-X v1.2.0 Grounded Document Intelligence & Hybrid RAG
-- Migration: 20261022000008_jarvis_x_document_intelligence.sql
--
-- STRICTLY ADDITIVE & NON-DESTRUCTIVE.
--   * No DROP TABLE / TRUNCATE / DELETE of existing user data.
--   * Only one constraint is relaxed (format_kind widened) — existing rows
--     remain valid under the wider constraint.
--   * Every new table gets ENABLE + FORCE ROW LEVEL SECURITY with owner-scoped
--     policies.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extend ingested_documents with real document-intelligence metadata.
--    (All columns nullable / defaulted so existing rows are untouched.)
-- -----------------------------------------------------------------------------
alter table public.ingested_documents
  add column if not exists content_hash text,
  add column if not exists page_count integer not null default 0,
  add column if not exists lifecycle text not null default 'READY',
  add column if not exists parser text,
  add column if not exists parser_version text,
  add column if not exists embedding_mode text,
  add column if not exists ocr_required boolean not null default false,
  add column if not exists page_provenance_available boolean not null default false,
  add column if not exists trust_level text not null default 'untrusted_external',
  add column if not exists deleted_at timestamptz;

-- Widen the format allow-list to cover the v1.2 parser set.
alter table public.ingested_documents
  drop constraint if exists ingested_documents_format_kind_check;

alter table public.ingested_documents
  add constraint ingested_documents_format_kind_check check (
    format_kind in (
      'markdown', 'text', 'csv', 'json', 'code',
      'pdf', 'docx', 'html', 'xml', 'yaml', 'toml'
    )
  );

create index if not exists idx_ingested_documents_content_hash
  on public.ingested_documents(user_id, content_hash)
  where content_hash is not null;

create index if not exists idx_ingested_documents_project
  on public.ingested_documents(project_id, created_at desc)
  where project_id is not null;

-- -----------------------------------------------------------------------------
-- 2. Retrievable document chunks with full provenance.
--    Owner isolation is enforced by RLS below; user_id is denormalized so the
--    policy needs no join (and cannot recurse).
-- -----------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.ingested_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  chunk_index integer not null default 0 check (chunk_index >= 0),
  chunk_key text not null,
  section text,
  heading_path text[] not null default '{}'::text[],
  page integer check (page is null or page > 0),
  page_start integer check (page_start is null or page_start > 0),
  page_end integer check (page_end is null or page_end > 0),
  text_content text not null,
  char_count integer not null default 0 check (char_count >= 0),
  token_estimate integer not null default 0 check (token_estimate >= 0),
  content_hash text not null,
  trust_level text not null default 'untrusted_external',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_document_chunks_owner_document
  on public.document_chunks(user_id, document_id, chunk_index);

create index if not exists idx_document_chunks_project
  on public.document_chunks(user_id, project_id);

create index if not exists idx_document_chunks_content_hash
  on public.document_chunks(user_id, content_hash);

-- Keyword / full-text channel of the hybrid retriever.
create index if not exists idx_document_chunks_fts
  on public.document_chunks
  using gin (to_tsvector('english', text_content));

alter table public.document_chunks enable row level security;
alter table public.document_chunks force row level security;

drop policy if exists "document_chunks_select_own" on public.document_chunks;
create policy "document_chunks_select_own"
  on public.document_chunks for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "document_chunks_insert_own" on public.document_chunks;
create policy "document_chunks_insert_own"
  on public.document_chunks for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "document_chunks_update_own" on public.document_chunks;
create policy "document_chunks_update_own"
  on public.document_chunks for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "document_chunks_delete_own" on public.document_chunks;
create policy "document_chunks_delete_own"
  on public.document_chunks for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- 3. Ensure the owner can delete their own ingested document rows.
--    (v1.0 migration created select+insert only.)
-- -----------------------------------------------------------------------------
drop policy if exists "ingested_documents_update_own" on public.ingested_documents;
create policy "ingested_documents_update_own"
  on public.ingested_documents for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "ingested_documents_delete_own" on public.ingested_documents;
create policy "ingested_documents_delete_own"
  on public.ingested_documents for delete
  to authenticated
  using ((select auth.uid()) = user_id);

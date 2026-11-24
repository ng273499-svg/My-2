-- =============================================================================
-- JARVIS-X v1.0 Multimodal Documents & Governed Proactive Workflows
-- Migration: 20261022000006_jarvis_x_multimodal_workflows.sql
-- Strictly additive & non-destructive (zero DROP TABLE / TRUNCATE / DELETE).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ingested Documents Metadata (quarantined knowledge ingestion lineage)
-- -----------------------------------------------------------------------------
create table if not exists public.ingested_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  file_name text not null,
  mime_type text not null default 'text/plain',
  size_bytes integer not null default 0 check (size_bytes >= 0),
  format_kind text not null default 'text' check (
    format_kind in ('markdown', 'text', 'csv', 'json', 'code')
  ),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  injection_flagged boolean not null default false,
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ingested_documents_user_id
  on public.ingested_documents(user_id, created_at desc);

drop trigger if exists set_ingested_documents_updated_at on public.ingested_documents;
create trigger set_ingested_documents_updated_at
  before update on public.ingested_documents
  for each row execute function public.handle_updated_at();

alter table public.ingested_documents enable row level security;
alter table public.ingested_documents force row level security;

drop policy if exists "ingested_documents_select_own" on public.ingested_documents;
create policy "ingested_documents_select_own"
  on public.ingested_documents for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "ingested_documents_insert_own" on public.ingested_documents;
create policy "ingested_documents_insert_own"
  on public.ingested_documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

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

-- -----------------------------------------------------------------------------
-- 2. Governed Proactive Workflows & Routines
-- -----------------------------------------------------------------------------
create table if not exists public.proactive_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  description text not null default '',
  trigger_kind text not null default 'manual' check (
    trigger_kind in ('manual', 'session_start', 'interval_advisory', 'event_watch')
  ),
  schedule_hint text,
  directive_prompt text not null,
  risk_level text not null default 'CONFIRMATION_REQUIRED' check (
    risk_level in ('READ_ONLY', 'LOW_RISK', 'CONFIRMATION_REQUIRED', 'SENSITIVE')
  ),
  enabled boolean not null default true,
  run_count integer not null default 0 check (run_count >= 0),
  last_run_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_proactive_workflows_user_id
  on public.proactive_workflows(user_id, created_at desc);

drop trigger if exists set_proactive_workflows_updated_at on public.proactive_workflows;
create trigger set_proactive_workflows_updated_at
  before update on public.proactive_workflows
  for each row execute function public.handle_updated_at();

alter table public.proactive_workflows enable row level security;
alter table public.proactive_workflows force row level security;

drop policy if exists "proactive_workflows_select_own" on public.proactive_workflows;
create policy "proactive_workflows_select_own"
  on public.proactive_workflows for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "proactive_workflows_insert_own" on public.proactive_workflows;
create policy "proactive_workflows_insert_own"
  on public.proactive_workflows for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "proactive_workflows_update_own" on public.proactive_workflows;
create policy "proactive_workflows_update_own"
  on public.proactive_workflows for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "proactive_workflows_delete_own" on public.proactive_workflows;
create policy "proactive_workflows_delete_own"
  on public.proactive_workflows for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- =============================================================================
-- JARVIS-X v1.3.0 Deep Research & Web Intelligence
-- Migration: 20261024000009_jarvis_x_deep_research.sql
--
-- STRICTLY ADDITIVE & NON-DESTRUCTIVE.
--   * No DROP TABLE / TRUNCATE / DELETE of existing user data.
--   * No existing constraint is tightened; nothing is removed.
--   * Every new table gets ENABLE + FORCE ROW LEVEL SECURITY with owner-scoped
--     policies identical in shape to the v1.0–v1.2 tables.
--
-- COPYRIGHT-SAFE BY DESIGN:
--   Only bounded evidence SNIPPETS and metadata are persisted. There is no
--   full-text mirror column: JARVIS keeps citations, hashes and short quotes,
--   never a copy of the page.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Research sessions — the durable foundation for resumable research.
--    v1.3 writes one row per completed run. It does NOT run unrestricted
--    background research; the state model simply makes resumption possible.
-- -----------------------------------------------------------------------------
create table if not exists public.research_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  task_id text not null,
  query text not null,
  mode text not null,
  status text not null default 'RUNNING',
  live boolean not null default false,
  search_provider text not null default 'unconfigured',
  provider_status text not null default 'UNCONFIGURED',
  confidence_level text not null default 'INSUFFICIENT',
  confidence_score numeric(4, 3) not null default 0,
  source_count integer not null default 0,
  evidence_count integer not null default 0,
  contradiction_count integer not null default 0,
  citation_count integer not null default 0,
  follow_up_rounds integer not null default 0,
  query_count integer not null default 0,
  duration_ms integer not null default 0,
  cancelled boolean not null default false,
  failure_codes text[] not null default '{}',
  limitations text[] not null default '{}',
  report_summary text,
  checked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint research_sessions_task_owner_unique unique (user_id, task_id)
);

create index if not exists idx_research_sessions_owner_created
  on public.research_sessions(user_id, created_at desc);

create index if not exists idx_research_sessions_project
  on public.research_sessions(project_id, created_at desc);

create index if not exists idx_research_sessions_task
  on public.research_sessions(user_id, task_id);

alter table public.research_sessions enable row level security;
alter table public.research_sessions force row level security;

drop policy if exists "research_sessions_select_own" on public.research_sessions;
create policy "research_sessions_select_own"
  on public.research_sessions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "research_sessions_insert_own" on public.research_sessions;
create policy "research_sessions_insert_own"
  on public.research_sessions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_sessions_update_own" on public.research_sessions;
create policy "research_sessions_update_own"
  on public.research_sessions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_sessions_delete_own" on public.research_sessions;
create policy "research_sessions_delete_own"
  on public.research_sessions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- 2. Research sources — normalized provenance for each retrieved source.
--    `snippet` is bounded evidence text (not the page).
-- -----------------------------------------------------------------------------
create table if not exists public.research_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.research_sessions(id) on delete cascade,
  source_id text not null,
  url text not null,
  canonical_url text not null,
  domain text not null,
  title text not null,
  author text,
  published_at timestamptz,
  updated_at_source timestamptz,
  retrieved_at timestamptz not null default timezone('utc', now()),
  content_hash text not null,
  source_type text not null default 'UNKNOWN',
  provenance text not null default 'WEB_SOURCE',
  fetch_status text not null default 'OK',
  quality_score numeric(4, 3) not null default 0,
  freshness_score numeric(4, 3) not null default 0,
  /** Bounded evidence snippet only — never a full-page mirror. */
  snippet text not null default '',
  duplicate_of text,
  independence_group text,
  trust_signals text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_research_sources_session
  on public.research_sources(user_id, session_id);

create index if not exists idx_research_sources_domain
  on public.research_sources(user_id, domain);

alter table public.research_sources enable row level security;
alter table public.research_sources force row level security;

drop policy if exists "research_sources_select_own" on public.research_sources;
create policy "research_sources_select_own"
  on public.research_sources for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "research_sources_insert_own" on public.research_sources;
create policy "research_sources_insert_own"
  on public.research_sources for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_sources_update_own" on public.research_sources;
create policy "research_sources_update_own"
  on public.research_sources for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_sources_delete_own" on public.research_sources;
create policy "research_sources_delete_own"
  on public.research_sources for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- 3. Research claims — verification state per claim, with provenance.
--    Only claims that reached an assessed state are stored, and every row
--    records whether the claim was corroborated or contested.
-- -----------------------------------------------------------------------------
create table if not exists public.research_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.research_sessions(id) on delete cascade,
  claim_id text not null,
  claim text not null,
  verification_state text not null default 'UNKNOWN',
  independent_support integer not null default 0,
  source_count integer not null default 0,
  confidence numeric(4, 3) not null default 0,
  contested boolean not null default false,
  supporting_source_ids text[] not null default '{}',
  contradicting_source_ids text[] not null default '{}',
  evidence_ids text[] not null default '{}',
  notes text[] not null default '{}',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_research_claims_session
  on public.research_claims(user_id, session_id);

create index if not exists idx_research_claims_state
  on public.research_claims(user_id, verification_state);

alter table public.research_claims enable row level security;
alter table public.research_claims force row level security;

drop policy if exists "research_claims_select_own" on public.research_claims;
create policy "research_claims_select_own"
  on public.research_claims for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "research_claims_insert_own" on public.research_claims;
create policy "research_claims_insert_own"
  on public.research_claims for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_claims_update_own" on public.research_claims;
create policy "research_claims_update_own"
  on public.research_claims for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "research_claims_delete_own" on public.research_claims;
create policy "research_claims_delete_own"
  on public.research_claims for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- 4. Research memory artefacts are stored through the existing hierarchical
--    memory table under the `knowledge` scope with provenance tags.
--    The category CHECK is only WIDENED (research_summary added); every
--    existing category remains valid, so no row is invalidated.
-- -----------------------------------------------------------------------------
alter table public.long_term_memories
  drop constraint if exists long_term_memories_category_check;

alter table public.long_term_memories
  add constraint long_term_memories_category_check check (
    category in (
      'preference', 'fact', 'project_context', 'episodic_summary',
      'workflow', 'knowledge_chunk', 'event_record', 'research_summary'
    )
  );

comment on table public.research_sessions is
  'JARVIS-X v1.3 research runs. Owner-scoped, FORCE RLS. Source text is never mirrored here.';
comment on table public.research_sources is
  'Normalized research provenance. Stores bounded snippets and hashes only.';
comment on table public.research_claims is
  'Claim graph with verification states. Unverified web claims are never promoted to facts.';

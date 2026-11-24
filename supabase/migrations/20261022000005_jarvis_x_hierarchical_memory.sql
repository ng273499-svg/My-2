-- =============================================================================
-- JARVIS-X v0.5 Advanced Hierarchical Memory Engine Migration
-- Migration: 20261022000005_jarvis_x_hierarchical_memory.sql
-- Non-destructive additive schema upgrade on `public.long_term_memories`:
--   1. Expands `category` CHECK constraint with `knowledge_chunk` and `event_record`
--   2. Adds hierarchical scope, lifecycle status, confidence, recall count,
--      provenance, supersession lineage (`superseded_by_id`), TTL (`expires_at`),
--      and structured `metadata` JSONB columns
--   3. Hardens `Users manage own memories` FORCE RLS policy to verify cross-row
--      ownership of `superseded_by_id`, `project_id`, and `source_conversation_id`
--   4. Updates `match_long_term_memories` to exclude superseded/archived/expired rows
--      and adds `match_hierarchical_memories` (`SECURITY INVOKER`) for scope-filtered
--      pgvector HNSW retrieval
-- =============================================================================

alter table public.long_term_memories
  drop constraint if exists long_term_memories_category_check;

alter table public.long_term_memories
  add constraint long_term_memories_category_check check (
    category in (
      'preference',
      'fact',
      'project_context',
      'episodic_summary',
      'workflow',
      'knowledge_chunk',
      'event_record'
    )
  );

alter table public.long_term_memories
  add column if not exists memory_scope text not null default 'semantic' check (
    memory_scope in (
      'working',
      'episodic',
      'semantic',
      'project',
      'knowledge',
      'procedural',
      'event'
    )
  ),
  add column if not exists memory_status text not null default 'active' check (
    memory_status in ('active', 'superseded', 'archived')
  ),
  add column if not exists confidence real not null default 0.9 check (
    confidence >= 0.0 and confidence <= 1.0
  ),
  add column if not exists recall_count integer not null default 0 check (
    recall_count >= 0
  ),
  add column if not exists provenance text not null default 'user_explicit' check (
    provenance in (
      'user_explicit',
      'operator_manual',
      'episodic_consolidation',
      'system_seed',
      'untrusted_external'
    )
  ),
  add column if not exists superseded_by_id uuid references public.long_term_memories(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Backfill existing rows' `memory_scope` based on `category` / `project_id` non-destructively
update public.long_term_memories
set memory_scope = case
  when project_id is not null or category = 'project_context' then 'project'
  when category = 'episodic_summary' then 'episodic'
  when category = 'workflow' then 'procedural'
  when category = 'knowledge_chunk' then 'knowledge'
  when category = 'event_record' then 'event'
  else 'semantic'
end
where memory_scope = 'semantic'
  and (
    project_id is not null
    or category in ('project_context', 'episodic_summary', 'workflow', 'knowledge_chunk', 'event_record')
  );

create index if not exists idx_memories_user_scope_status
  on public.long_term_memories(user_id, memory_scope, memory_status);

create index if not exists idx_memories_user_project
  on public.long_term_memories(user_id, project_id);

-- Enforce same-user ownership of `superseded_by_id` via BEFORE trigger to avoid
-- PostgreSQL 42P17 self-referential RLS policy recursion while preserving ON DELETE SET NULL
create or replace function public.enforce_memory_supersession_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.superseded_by_id is not null then
    if new.superseded_by_id = new.id then
      raise exception 'Memory entry cannot supersede itself';
    end if;
    if not exists (
      select 1 from public.long_term_memories m
      where m.id = new.superseded_by_id and m.user_id = new.user_id
    ) then
      raise exception 'Cross-tenant or missing superseded_by_id reference denied';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists check_memory_supersession_tenant on public.long_term_memories;
create trigger check_memory_supersession_tenant
  before insert or update of superseded_by_id, user_id on public.long_term_memories
  for each row execute function public.enforce_memory_supersession_tenant();

alter table public.long_term_memories force row level security;

drop policy if exists "Users manage own memories" on public.long_term_memories;
create policy "Users manage own memories"
  on public.long_term_memories
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.user_id = (select auth.uid())
      )
    )
    and (
      source_conversation_id is null
      or exists (
        select 1 from public.conversations c
        where c.id = source_conversation_id and c.user_id = (select auth.uid())
      )
    )
  );

-- Upgrade backward-compatible `match_long_term_memories` to filter active & non-expired memories
create or replace function public.match_long_term_memories(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.72,
  match_count int default 8,
  filter_project_id uuid default null
)
returns table (
  id uuid,
  category text,
  content text,
  tags text[],
  importance smallint,
  verified boolean,
  similarity float,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    m.id,
    m.category,
    m.content,
    m.tags,
    m.importance,
    m.verified,
    (1 - (m.embedding <=> query_embedding))::float as similarity,
    m.created_at
  from public.long_term_memories m
  where m.user_id = (select auth.uid())
    and m.memory_status = 'active'
    and (m.expires_at is null or m.expires_at > timezone('utc', now()))
    and m.embedding is not null
    and (filter_project_id is null or m.project_id = filter_project_id)
    and (1 - (m.embedding <=> query_embedding)) >= match_threshold
  order by m.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 50);
$$;

grant execute on function public.match_long_term_memories(extensions.vector(1536), float, int, uuid) to authenticated;
revoke execute on function public.match_long_term_memories(extensions.vector(1536), float, int, uuid) from anon;

-- Scope-aware `match_hierarchical_memories` (`SECURITY INVOKER`)
create or replace function public.match_hierarchical_memories(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.45,
  match_count int default 12,
  filter_project_id uuid default null,
  filter_scope text default null
)
returns table (
  id uuid,
  project_id uuid,
  category text,
  memory_scope text,
  memory_status text,
  content text,
  tags text[],
  importance smallint,
  confidence real,
  recall_count integer,
  provenance text,
  verified boolean,
  similarity float,
  last_recalled_at timestamptz,
  expires_at timestamptz,
  metadata jsonb,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    m.id,
    m.project_id,
    m.category,
    m.memory_scope,
    m.memory_status,
    m.content,
    m.tags,
    m.importance,
    m.confidence,
    m.recall_count,
    m.provenance,
    m.verified,
    (1 - (m.embedding <=> query_embedding))::float as similarity,
    m.last_recalled_at,
    m.expires_at,
    m.metadata,
    m.created_at
  from public.long_term_memories m
  where m.user_id = (select auth.uid())
    and m.memory_status = 'active'
    and (m.expires_at is null or m.expires_at > timezone('utc', now()))
    and m.embedding is not null
    and (filter_scope is null or m.memory_scope = filter_scope)
    and (
      (filter_project_id is null and m.memory_scope <> 'project')
      or m.project_id = filter_project_id
      or (filter_project_id is not null and m.project_id is null and m.memory_scope <> 'project')
    )
    and (1 - (m.embedding <=> query_embedding)) >= match_threshold
  order by m.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 50);
$$;

grant execute on function public.match_hierarchical_memories(extensions.vector(1536), float, int, uuid, text) to authenticated;
revoke execute on function public.match_hierarchical_memories(extensions.vector(1536), float, int, uuid, text) from anon;

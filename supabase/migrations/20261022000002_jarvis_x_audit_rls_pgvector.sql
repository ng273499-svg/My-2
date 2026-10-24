-- =============================================================================
-- JARVIS-X Audit Logs, Strict Multi-Tenant RLS Hardening & pgvector Search
-- Migration: 20261022000002_jarvis_x_audit_rls_pgvector.sql
-- Non-destructive hardening migration:
--   1. Adds immutable append-only `public.audit_logs` table
--   2. Enforces FORCE ROW LEVEL SECURITY + revokes `anon` access across all tables
--   3. Adds cross-tenant foreign-key guards on RLS policies (`authenticated` only)
--   4. Adds HNSW vector similarity index + `match_long_term_memories` RPC (pgvector)
--   5. Upgrades `handle_new_auth_user()` trigger to provision profile, preferences,
--      default workspace project, and initial audit log safely (ON CONFLICT DO NOTHING)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Immutable Security & Operational Audit Logs (`public.audit_logs`)
-- -----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  entity_type text not null check (
    entity_type in (
      'auth', 'profile', 'conversation', 'message', 'memory',
      'project', 'agent_task', 'connected_tool', 'preference', 'permission'
    )
  ),
  entity_id text,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_audit_logs_user_created
  on public.audit_logs(user_id, created_at desc);

alter table public.audit_logs enable row level security;

-- -----------------------------------------------------------------------------
-- 2. Force RLS & Least-Privilege Role Grants (Zero `anon` table access)
-- -----------------------------------------------------------------------------
alter table public.user_profiles force row level security;
alter table public.projects force row level security;
alter table public.conversations force row level security;
alter table public.conversation_messages force row level security;
alter table public.long_term_memories force row level security;
alter table public.agent_tasks force row level security;
alter table public.connected_tools force row level security;
alter table public.preferences force row level security;
alter table public.permission_records force row level security;
alter table public.audit_logs force row level security;

revoke all on public.user_profiles from anon;
revoke all on public.projects from anon;
revoke all on public.conversations from anon;
revoke all on public.conversation_messages from anon;
revoke all on public.long_term_memories from anon;
revoke all on public.agent_tasks from anon;
revoke all on public.connected_tools from anon;
revoke all on public.preferences from anon;
revoke all on public.permission_records from anon;
revoke all on public.audit_logs from anon;

grant select, insert, update, delete on public.user_profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.conversation_messages to authenticated;
grant select, insert, update, delete on public.long_term_memories to authenticated;
grant select, insert, update, delete on public.agent_tasks to authenticated;
grant select, insert, update, delete on public.connected_tools to authenticated;
grant select, insert, update, delete on public.preferences to authenticated;

-- Permission records: no DELETE allowed to authenticated clients
revoke delete on public.permission_records from authenticated;
grant select, insert, update on public.permission_records to authenticated;

-- Audit logs: strictly append-only (SELECT + INSERT only, zero UPDATE or DELETE)
revoke update, delete on public.audit_logs from authenticated;
grant select, insert on public.audit_logs to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Strict Per-User RLS Policies (with Cross-Tenant FK Ownership Verification)
-- -----------------------------------------------------------------------------

-- user_profiles
drop policy if exists "Users manage own profile" on public.user_profiles;
create policy "Users manage own profile"
  on public.user_profiles
  for all
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- projects
drop policy if exists "Users manage own projects" on public.projects;
create policy "Users manage own projects"
  on public.projects
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- conversations (also verifies optional project_id belongs to the same user)
drop policy if exists "Users manage own conversations" on public.conversations;
create policy "Users manage own conversations"
  on public.conversations
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
  );

-- conversation_messages (verifies parent conversation belongs to the same user)
drop policy if exists "Users manage own conversation messages" on public.conversation_messages;
create policy "Users manage own conversation messages"
  on public.conversation_messages
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );

-- long_term_memories (verifies optional project & source conversation ownership)
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

-- agent_tasks
drop policy if exists "Users manage own agent tasks" on public.agent_tasks;
create policy "Users manage own agent tasks"
  on public.agent_tasks
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      conversation_id is null
      or exists (
        select 1 from public.conversations c
        where c.id = conversation_id and c.user_id = (select auth.uid())
      )
    )
  );

-- connected_tools
drop policy if exists "Users manage own connected tools" on public.connected_tools;
create policy "Users manage own connected tools"
  on public.connected_tools
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- preferences
drop policy if exists "Users manage own preferences" on public.preferences;
create policy "Users manage own preferences"
  on public.preferences
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- permission_records (read own, insert own, resolve ONLY own pending decisions)
drop policy if exists "Users read own permission records" on public.permission_records;
drop policy if exists "Users insert own permission records" on public.permission_records;
drop policy if exists "Users resolve own pending permission records" on public.permission_records;

create policy "Users read own permission records"
  on public.permission_records
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users insert own permission records"
  on public.permission_records
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users resolve own pending permission records"
  on public.permission_records
  for update
  to authenticated
  using ((select auth.uid()) = user_id and decision = 'pending')
  with check ((select auth.uid()) = user_id);

-- audit_logs (immutable append-only per-user policy: SELECT & INSERT only)
drop policy if exists "Users read own audit logs" on public.audit_logs;
drop policy if exists "Users append own audit logs" on public.audit_logs;

create policy "Users read own audit logs"
  on public.audit_logs
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users append own audit logs"
  on public.audit_logs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- 4. pgvector Semantic Search Support (`long_term_memories`)
-- -----------------------------------------------------------------------------
create index if not exists idx_long_term_memories_embedding_hnsw
  on public.long_term_memories
  using hnsw (embedding extensions.vector_cosine_ops);

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
    and m.embedding is not null
    and (filter_project_id is null or m.project_id = filter_project_id)
    and (1 - (m.embedding <=> query_embedding)) >= match_threshold
  order by m.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 50);
$$;

grant execute on function public.match_long_term_memories(extensions.vector(1536), float, int, uuid) to authenticated;
revoke execute on function public.match_long_term_memories(extensions.vector(1536), float, int, uuid) from anon;

-- -----------------------------------------------------------------------------
-- 5. Safe Non-Destructive Auth User Provisioning Trigger
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
      split_part(coalesce(new.email, 'Operator'), '@', 1)
    )
  )
  on conflict (id) do nothing;

  insert into public.preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.projects (user_id, name, slug, description)
  values (
    new.id,
    'JARVIS-X Personal Workspace',
    'jarvis-x-personal',
    'Default isolated workspace provisioned on operator registration.'
  )
  on conflict (user_id, slug) do nothing;

  insert into public.audit_logs (user_id, event_type, entity_type, entity_id, severity, summary)
  values (
    new.id,
    'auth.user_provisioned',
    'auth',
    new.id::text,
    'info',
    'Initialized operator profile, default preferences, and personal workspace.'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

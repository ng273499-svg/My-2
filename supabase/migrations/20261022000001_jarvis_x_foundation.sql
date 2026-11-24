-- =============================================================================
-- JARVIS-X Foundation Schema & Row-Level Security (RLS)
-- Migration: 20261022000001_jarvis_x_foundation.sql
-- Verified non-destructive DDL (no DROP TABLE / TRUNCATE / DELETE).
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "vector" with schema extensions;

-- Shared updated_at trigger helper
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1 & 2. User Profiles (linked to Supabase Auth auth.users)
-- -----------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Operator',
  callsign text not null default 'PRIME-01',
  avatar_url text,
  timezone text not null default 'UTC',
  locale text not null default 'en-US',
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Projects (workspace / context containers for conversations & tasks)
-- -----------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, slug)
);

create index if not exists idx_projects_user_id on public.projects(user_id);

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
  before update on public.projects
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Conversations & Conversation Messages
-- -----------------------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default 'New Command Session',
  summary text,
  active_model_id text not null default 'foundation-local-v1',
  last_response_style text not null default 'calm',
  archived boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_conversations_user_updated
  on public.conversations(user_id, updated_at desc);

drop trigger if exists set_conversations_updated_at on public.conversations;
create trigger set_conversations_updated_at
  before update on public.conversations
  for each row execute function public.handle_updated_at();

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  response_style text check (
    response_style in (
      'calm', 'excitement', 'concern', 'curiosity',
      'confidence', 'seriousness', 'humor', 'urgency'
    )
  ),
  model_id text,
  specialist_agent_id text,
  verification_status text check (verification_status in ('verified', 'caution', 'blocked', 'pending')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_messages_conversation_created
  on public.conversation_messages(conversation_id, created_at asc);

create index if not exists idx_messages_user_id
  on public.conversation_messages(user_id);

-- -----------------------------------------------------------------------------
-- 4. Long-Term Memories (semantic pgvector + structured persistent facts)
-- -----------------------------------------------------------------------------
create table if not exists public.long_term_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  category text not null default 'fact' check (
    category in ('preference', 'fact', 'project_context', 'episodic_summary', 'workflow')
  ),
  content text not null,
  tags text[] not null default '{}',
  importance smallint not null default 3 check (importance between 1 and 5),
  source_conversation_id uuid references public.conversations(id) on delete set null,
  embedding extensions.vector(1536),
  verified boolean not null default true,
  last_recalled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_memories_user_category
  on public.long_term_memories(user_id, category);

drop trigger if exists set_long_term_memories_updated_at on public.long_term_memories;
create trigger set_long_term_memories_updated_at
  before update on public.long_term_memories
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 6. Agent Tasks (autonomous & specialist sub-agent execution records)
-- -----------------------------------------------------------------------------
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  specialist_agent text not null check (
    specialist_agent in ('research', 'coding', 'design', 'memory', 'automation', 'verification')
  ),
  objective text not null,
  lifecycle_stage text not null default 'understanding' check (
    lifecycle_stage in (
      'understanding', 'planning', 'selecting', 'executing',
      'verifying', 'completed', 'awaiting_permission', 'blocked', 'failed'
    )
  ),
  permission_tier text not null default 'SAFE_READ' check (
    permission_tier in ('SAFE_READ', 'CONFIRMATION_REQUIRED', 'SENSITIVE_AUTH_REQUIRED')
  ),
  status_summary text not null,
  result_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_agent_tasks_user_created
  on public.agent_tasks(user_id, created_at desc);

drop trigger if exists set_agent_tasks_updated_at on public.agent_tasks;
create trigger set_agent_tasks_updated_at
  before update on public.agent_tasks
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Connected Tools (external connector metadata — NEVER store raw secrets)
-- -----------------------------------------------------------------------------
create table if not exists public.connected_tools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_slug text not null,
  display_name text not null,
  category text not null check (
    category in (
      'internal', 'web_research', 'file_analysis', 'computer_use',
      'code_execution', 'external_api', 'smart_device', 'notifications', 'sync'
    )
  ),
  connection_status text not null default 'not_connected' check (
    connection_status in ('connected', 'not_connected', 'degraded', 'revoked')
  ),
  default_permission_tier text not null default 'CONFIRMATION_REQUIRED' check (
    default_permission_tier in ('SAFE_READ', 'CONFIRMATION_REQUIRED', 'SENSITIVE_AUTH_REQUIRED')
  ),
  vault_secret_ref text,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, tool_slug)
);

create index if not exists idx_connected_tools_user_id
  on public.connected_tools(user_id);

drop trigger if exists set_connected_tools_updated_at on public.connected_tools;
create trigger set_connected_tools_updated_at
  before update on public.connected_tools
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 8. Preferences (Persona, Female Voice Calibration, Routing & Proactive Settings)
-- -----------------------------------------------------------------------------
create table if not exists public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferred_response_style text not null default 'calm' check (
    preferred_response_style in (
      'calm', 'excitement', 'concern', 'curiosity',
      'confidence', 'seriousness', 'humor', 'urgency'
    )
  ),
  voice_profile_id text not null default 'jarvis-x-aria-female-v1',
  voice_auto_speak boolean not null default false,
  voice_barge_in_enabled boolean not null default true,
  wit_level text not null default 'subtle' check (wit_level in ('minimal', 'subtle', 'moderate')),
  conciseness text not null default 'balanced' check (conciseness in ('brief', 'balanced', 'detailed')),
  preferred_model_provider text not null default 'auto',
  proactive_assistance_enabled boolean not null default false,
  cross_device_sync_enabled boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists set_preferences_updated_at on public.preferences;
create trigger set_preferences_updated_at
  before update on public.preferences
  for each row execute function public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 9. Permission Records (3-Tier Governance Decisions)
-- -----------------------------------------------------------------------------
create table if not exists public.permission_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  action_code text not null,
  target_resource text not null,
  permission_tier text not null check (
    permission_tier in ('SAFE_READ', 'CONFIRMATION_REQUIRED', 'SENSITIVE_AUTH_REQUIRED')
  ),
  decision text not null check (
    decision in ('auto_allowed', 'pending', 'approved', 'denied', 'blocked_unauthenticated')
  ),
  verified_auth_method text,
  rationale text,
  created_at timestamptz not null default timezone('utc', now()),
  resolved_at timestamptz
);

create index if not exists idx_permission_records_user_created
  on public.permission_records(user_id, created_at desc);

-- Enable baseline Row Level Security on all foundation tables
alter table public.user_profiles enable row level security;
alter table public.projects enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.long_term_memories enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.connected_tools enable row level security;
alter table public.preferences enable row level security;
alter table public.permission_records enable row level security;

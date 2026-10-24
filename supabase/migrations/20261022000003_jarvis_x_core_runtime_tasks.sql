-- =============================================================================
-- JARVIS-X Core Runtime Operational Metadata & RLS Hardening
-- Migration: 20261022000003_jarvis_x_core_runtime_tasks.sql
-- Strictly additive & non-destructive migration:
--   1. Expands `public.agent_tasks` to support all 10 specialist contracts + direct_core
--   2. Expands `lifecycle_stage` check to cover the full bounded Core Runtime state machine
--   3. Adds Core Runtime operational audit columns (`task_type`, `risk_level`,
--      `selected_capability`, `execution_state`, `approval_state`, `verification_status`,
--      `error_status`, `started_at`, `completed_at`)
--   4. Hardens `agent_tasks` RLS policy to also verify `project_id` tenant ownership
-- =============================================================================

alter table public.agent_tasks
  drop constraint if exists agent_tasks_specialist_agent_check;

alter table public.agent_tasks
  add constraint agent_tasks_specialist_agent_check check (
    specialist_agent in (
      'direct_core',
      'research',
      'coding',
      'planning',
      'vision',
      'memory',
      'automation',
      'verification',
      'cybersecurity',
      'data',
      'design'
    )
  );

alter table public.agent_tasks
  drop constraint if exists agent_tasks_lifecycle_stage_check;

alter table public.agent_tasks
  add constraint agent_tasks_lifecycle_stage_check check (
    lifecycle_stage in (
      'understanding',
      'planning',
      'selecting',
      'executing',
      'verifying',
      'completed',
      'awaiting_permission',
      'blocked',
      'failed',
      'RECEIVED',
      'UNDERSTANDING',
      'CONTEXT_LOADING',
      'PLANNING',
      'SELECTING_CAPABILITY',
      'EXECUTING',
      'OBSERVING',
      'VERIFYING',
      'COMPLETED',
      'WAITING_FOR_USER_APPROVAL',
      'FAILED',
      'CANCELLED'
    )
  );

alter table public.agent_tasks
  add column if not exists task_type text not null default 'conversation',
  add column if not exists risk_level text not null default 'READ_ONLY' check (
    risk_level in ('READ_ONLY', 'LOW_RISK', 'CONFIRMATION_REQUIRED', 'SENSITIVE')
  ),
  add column if not exists selected_capability text not null default 'direct_conversation',
  add column if not exists execution_state text not null default 'COMPLETED' check (
    execution_state in (
      'RECEIVED',
      'UNDERSTANDING',
      'CONTEXT_LOADING',
      'PLANNING',
      'SELECTING_CAPABILITY',
      'EXECUTING',
      'OBSERVING',
      'VERIFYING',
      'COMPLETED',
      'WAITING_FOR_USER_APPROVAL',
      'FAILED',
      'CANCELLED'
    )
  ),
  add column if not exists approval_state text not null default 'not_required' check (
    approval_state in (
      'not_required',
      'pending',
      'approved',
      'denied',
      'blocked_unauthenticated'
    )
  ),
  add column if not exists verification_status text not null default 'VERIFIED' check (
    verification_status in (
      'VERIFIED',
      'PARTIALLY_VERIFIED',
      'FAILED_VERIFICATION',
      'NOT_VERIFIABLE'
    )
  ),
  add column if not exists error_status text,
  add column if not exists started_at timestamptz not null default timezone('utc', now()),
  add column if not exists completed_at timestamptz;

create index if not exists idx_agent_tasks_execution_state
  on public.agent_tasks(user_id, execution_state, created_at desc);

-- Harden agent_tasks RLS policy to verify both conversation_id and project_id tenant ownership
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
    and (
      project_id is null
      or exists (
        select 1 from public.projects p
        where p.id = project_id and p.user_id = (select auth.uid())
      )
    )
  );

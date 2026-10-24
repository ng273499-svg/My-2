-- =============================================================================
-- JARVIS-X Multi-Model Routing Policy Preferences
-- Migration: 20261022000004_jarvis_x_routing_policy.sql
-- Non-destructive additive columns on `public.preferences` (FORCE RLS preserved):
--   - `routing_policy`: AUTO_BALANCED (default) | QUALITY_FIRST | SPEED_FIRST | COST_AWARE | MANUAL
--   - `manual_model_id`: optional model identifier when `routing_policy = 'MANUAL'`
-- =============================================================================

alter table public.preferences
  add column if not exists routing_policy text not null default 'AUTO_BALANCED' check (
    routing_policy in (
      'AUTO_BALANCED',
      'QUALITY_FIRST',
      'SPEED_FIRST',
      'COST_AWARE',
      'MANUAL'
    )
  ),
  add column if not exists manual_model_id text;

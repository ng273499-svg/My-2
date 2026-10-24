import type { ProactiveAdvisory } from '@/core/types';
import type { ProactiveWorkflowRecord } from '@/server/repositories/types';

/**
 * Proactive Monitoring Engine (JARVIS-X v1.0)
 * Manages non-intrusive system advisories and evaluates governed proactive workflows
 * without ever bypassing RiskClassifier, PermissionManager, or VerificationLayer.
 */
export class ProactiveMonitoringEngine {
  getAdvisories(options: {
    supabaseConfigured: boolean;
    serverReachability: 'connected' | 'degraded_unreachable' | 'not_configured';
    authenticated: boolean;
    externalModelsConfigured: boolean;
    proactiveEnabled: boolean;
    workflows?: ProactiveWorkflowRecord[];
  }): ProactiveAdvisory[] {
    const now = new Date().toISOString();
    const advisories: ProactiveAdvisory[] = [];

    if (!options.supabaseConfigured) {
      advisories.push({
        id: 'adv-supabase-unconfigured',
        title: 'Supabase Credentials Unset (Ephemeral Mode)',
        summary:
          'Set SUPABASE_URL and SUPABASE_ANON_KEY on the server to activate cloud persistence.',
        priority: 'attention',
        category: 'memory',
        createdAt: now,
      });
    } else if (options.serverReachability === 'degraded_unreachable') {
      advisories.push({
        id: 'adv-supabase-degraded',
        title: 'Server Egress Degraded · Resilient Fallback Active',
        summary:
          'Supabase database migrations & FORCE RLS are live, while container-to-cloud egress is firewalled. Browser RLS sync is available when signed in.',
        priority: 'attention',
        category: 'system',
        createdAt: now,
      });
    } else if (!options.authenticated) {
      advisories.push({
        id: 'adv-auth-guest',
        title: 'Guest Ephemeral Session Active',
        summary:
          'Sign in via Operator Auth in the header to persist conversations, memories, preferences, workflows, and audit logs under Supabase Row-Level Security.',
        priority: 'info',
        category: 'memory',
        createdAt: now,
      });
    } else {
      advisories.push({
        id: 'adv-supabase-cloud-active',
        title: 'Supabase RLS & pgvector Foundation Active',
        summary:
          'Authenticated operator session isolated by PostgreSQL FORCE ROW LEVEL SECURITY across all 12 tables.',
        priority: 'info',
        category: 'system',
        createdAt: now,
      });
    }

    if (options.proactiveEnabled) {
      const enabledCount = (options.workflows ?? []).filter((w) => w.enabled).length;
      advisories.push({
        id: 'adv-proactive-cron',
        title:
          enabledCount > 0
            ? `Governed Proactive Workflows Ready (${enabledCount} Active)`
            : 'Proactive Assistance Enabled (In-Session)',
        summary:
          enabledCount > 0
            ? `${enabledCount} governed workflow(s) registered. Every execution routes through JarvisCoreRuntime & PermissionManager.`
            : 'In-session contextual advisories & governed workflow registry are active.',
        priority: 'info',
        category: 'schedule_interface',
        createdAt: now,
      });
    }

    return advisories;
  }

  /**
   * Computes which enabled interval workflows are due for an operator advisory check.
   * Never executes elevated actions silently.
   */
  listDueWorkflows(
    workflows: ProactiveWorkflowRecord[],
    nowMs = Date.now()
  ): ProactiveWorkflowRecord[] {
    return workflows.filter((wf) => {
      if (!wf.enabled) return false;
      if (wf.triggerKind === 'session_start' && wf.runCount === 0) return true;
      if (wf.triggerKind === 'interval_advisory') {
        if (!wf.lastRunAt) return true;
        const rawInterval = Number(wf.metadata?.intervalMinutes ?? 60);
        const intervalMin = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 60;
        const elapsedMin = (nowMs - Date.parse(wf.lastRunAt)) / 60_000;
        return elapsedMin >= intervalMin;
      }
      return false;
    });
  }
}

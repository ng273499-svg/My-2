import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JarvisDashboard } from '@/components/JarvisDashboard';
import { JarvisCore } from '@/core/modules/jarvis-core';
import { InMemorySessionRepository } from '@/server/repositories/in-memory-repository';
import {
  SUPABASE_MIGRATION_PATHS,
  SUPABASE_PREPARED_DOMAINS,
} from '@/server/supabase/client';

async function buildInitialSnapshot() {
  const core = new JarvisCore(new InMemorySessionRepository(), () => ({
    configured: true,
    projectRef: 'jdlxnidzakdtksjzazqe',
    serverReachability: 'connected',
    authReady: true,
    pgvectorEnabled: true,
    rlsForced: true,
    hasServiceRole: true,
    persistenceMode: 'ephemeral_session',
    domainsPrepared: SUPABASE_PREPARED_DOMAINS,
    migrationPath: SUPABASE_MIGRATION_PATHS[SUPABASE_MIGRATION_PATHS.length - 1],
    migrationPaths: SUPABASE_MIGRATION_PATHS,
    statusDetail: 'Supabase Cloud online & verified.',
  }));
  return core.getSystemSnapshot();
}

describe('JARVIS-X Responsive Dashboard, Auth UI & Real Runtime Activity Panel', () => {
  it('renders central AI core orb, conversation switcher, auth control, and real Core Runtime stage standby list + 10 specialist contracts', async () => {
    const snapshot = await buildInitialSnapshot();
    render(<JarvisDashboard initialSnapshot={snapshot} initialMessages={[]} />);

    expect(screen.getByText('JARVIS-X')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();

    // Central Orb (both desktop & mobile compact variants exist in responsive DOM)
    expect(screen.getByTestId('jarvis-core-orb')).toBeInTheDocument();
    expect(screen.getByTestId('jarvis-core-orb-compact')).toBeInTheDocument();

    // Conversation switcher & New Session controls
    expect(screen.getAllByLabelText('Select active conversation').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText('Start new conversation session').length).toBeGreaterThanOrEqual(1);

    // Operator Auth trigger (44px accessible button)
    const signInBtn = screen.getByLabelText('Sign in to Supabase Operator Account');
    expect(signInBtn).toBeInTheDocument();
    expect(signInBtn.className).toContain('min-h-[44px]');

    // Multimodal Controls (Mic, Camera/Vision, Input, Send)
    expect(screen.getAllByLabelText(/Activate microphone input/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText(/Open Camera and Vision Engine Inspector/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText(/Command or message to JARVIS-X/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByLabelText(/Send message to JARVIS-X/i).length).toBeGreaterThanOrEqual(1);

    // Real Core Runtime Standby Stage Pipeline & 10 Specialist Contracts
    expect(screen.getByText(/1\. Understanding/i)).toBeInTheDocument();
    expect(screen.getByText(/2\. Loading context/i)).toBeInTheDocument();
    expect(screen.getByText(/3\. Planning/i)).toBeInTheDocument();
    expect(screen.getByText(/4\. Selecting capability/i)).toBeInTheDocument();
    expect(screen.getByText(/5\. Executing/i)).toBeInTheDocument();
    expect(screen.getByText(/6\. Verifying/i)).toBeInTheDocument();
    expect(screen.getByText(/7\. Completed/i)).toBeInTheDocument();
    expect(screen.getByText('10 REGISTERED')).toBeInTheDocument();
  });

  it('supports mobile section switching (Console / Activity / Core & Mem) with 44px+ accessible touch targets', async () => {
    const snapshot = await buildInitialSnapshot();
    render(<JarvisDashboard initialSnapshot={snapshot} initialMessages={[]} />);

    const mobileNav = screen.getByLabelText('Mobile Workspace Sections');
    expect(mobileNav).toBeInTheDocument();

    const consoleBtn = screen.getByRole('button', { name: /Console/i });
    const activityBtn = screen.getByRole('button', { name: /Activity/i });
    const systemsBtn = screen.getByRole('button', { name: /Core & Mem/i });

    expect(consoleBtn.className).toContain('min-h-[44px]');
    expect(activityBtn.className).toContain('min-h-[44px]');
    expect(systemsBtn.className).toContain('min-h-[44px]');

    fireEvent.click(activityBtn);
    expect(screen.getAllByTestId('agent-activity-panel').length).toBe(2);

    fireEvent.click(systemsBtn);
    expect(screen.getAllByText('Tools & Capability Interfaces').length).toBe(2);
  });

  it('opens Operator Authentication Modal, Vision Modal, and Settings Supabase & Audit Log tabs cleanly', async () => {
    const snapshot = await buildInitialSnapshot();
    render(<JarvisDashboard initialSnapshot={snapshot} initialMessages={[]} />);

    // Open Operator Auth Modal
    fireEvent.click(screen.getByLabelText('Sign in to Supabase Operator Account'));
    expect(screen.getByText('Operator Authentication')).toBeInTheDocument();
    expect(screen.getByText('Authenticate with Supabase RLS')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close Authentication Modal'));

    // Open Vision Modal
    fireEvent.click(screen.getAllByLabelText(/Open Camera and Vision Engine Inspector/i)[0]);
    expect(screen.getByText(/Multimodal Vision LLM: Not Connected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close Vision Inspector'));

    // Open Settings Drawer -> Supabase & Security Audit Logs
    fireEvent.click(screen.getByLabelText('Open JARVIS-X Settings and Architecture Controls'));
    fireEvent.click(screen.getByRole('button', { name: /^Supabase$/i }));
    expect(screen.getByText('audit_logs')).toBeInTheDocument();
    expect(screen.getByText('pgvector 0.8 + FORCE RLS')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Security$/i }));
    expect(screen.getByText(/Immutable Audit Logs/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Models$/i }));
    expect(screen.getByLabelText('Select Model Routing Policy')).toBeInTheDocument();
    expect(screen.getByText('Provider Health & Circuit Breakers')).toBeInTheDocument();
    expect(screen.getAllByText('UNCONFIGURED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('CONFIGURED').length).toBeGreaterThanOrEqual(1);
  });
});

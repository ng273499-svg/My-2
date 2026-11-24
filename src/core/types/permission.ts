/**
 * Three-tier security & permission architecture:
 * - SAFE_READ: Read-only diagnostics, conversation, local memory reads.
 * - CONFIRMATION_REQUIRED: Mutating persistent memory, preferences, project tasks, or external writes.
 * - SENSITIVE_AUTH_REQUIRED: Device actuation, computer/browser control, code execution,
 *   credentialed external APIs, or destructive operations. Never performed silently.
 */
export type PermissionTier =
  | 'SAFE_READ'
  | 'CONFIRMATION_REQUIRED'
  | 'SENSITIVE_AUTH_REQUIRED';

export type PermissionDecisionStatus =
  | 'auto_allowed'
  | 'pending'
  | 'approved'
  | 'denied'
  | 'blocked_unauthenticated';

export interface PermissionRequest {
  id: string;
  conversationId: string;
  actionCode: string;
  actionTitle: string;
  targetResource: string;
  tier: PermissionTier;
  summary: string;
  impactDescription: string;
  requiresStepUpAuth: boolean;
  pendingPayload: Record<string, unknown>;
  createdAt: string;
}

export interface PermissionRecord {
  id: string;
  conversationId: string;
  actionCode: string;
  targetResource: string;
  tier: PermissionTier;
  decision: PermissionDecisionStatus;
  verifiedAuthMethod?: string;
  rationale: string;
  createdAt: string;
  resolvedAt?: string;
}

export type AuditEntityType =
  | 'auth'
  | 'profile'
  | 'conversation'
  | 'message'
  | 'memory'
  | 'project'
  | 'agent_task'
  | 'connected_tool'
  | 'preference'
  | 'permission';

export interface AuditLogEntry {
  id: string;
  eventType: string;
  entityType: AuditEntityType;
  entityId?: string;
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SecurityEvaluation {
  allowedImmediately: boolean;
  tier: PermissionTier;
  decision: PermissionDecisionStatus;
  pendingRequest?: PermissionRequest;
  auditRecord: PermissionRecord;
}

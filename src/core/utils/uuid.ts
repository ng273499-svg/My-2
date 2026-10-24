const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_GUEST_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_CONVERSATION_ID = '00000000-0000-4000-8000-000000000101';

export function isValidUuid(value?: string | null): value is string {
  return Boolean(value && UUID_REGEX.test(value.trim()));
}

/**
 * Ensures any conversation/entity identifier is a valid Postgres UUID.
 * Maps legacy 'conv-default-01' cleanly to DEFAULT_CONVERSATION_ID.
 */
export function normalizeConversationId(value?: string | null): string {
  if (!value || value === 'conv-default-01') {
    return DEFAULT_CONVERSATION_ID;
  }
  if (isValidUuid(value)) {
    return value.trim().toLowerCase();
  }
  return DEFAULT_CONVERSATION_ID;
}

export function generateUuid(): string {
  return crypto.randomUUID();
}

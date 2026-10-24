import type { ProviderFailureKind } from '@/core/types';
import { redactSecrets } from './provider-config';

export interface ProviderAdapterErrorOptions {
  providerId: string;
  modelId: string;
  failureKind: ProviderFailureKind;
  message: string;
  retryable?: boolean;
  httpStatus?: number;
  cause?: unknown;
}

/**
 * Provider-neutral error thrown exclusively inside provider adapters and structured
 * output validators. Never leaks API keys, bearer tokens, or raw auth headers.
 */
export class ProviderAdapterError extends Error {
  public readonly providerId: string;
  public readonly modelId: string;
  public readonly failureKind: ProviderFailureKind;
  public readonly retryable: boolean;
  public readonly httpStatus?: number;

  constructor(options: ProviderAdapterErrorOptions) {
    const safeMsg = redactSecrets(options.message);
    super(safeMsg);
    this.name = 'ProviderAdapterError';
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.failureKind = options.failureKind;
    this.httpStatus = options.httpStatus;
    this.retryable =
      options.retryable ??
      (options.failureKind === 'TEMPORARY_PROVIDER_FAILURE' ||
        options.failureKind === 'RATE_LIMIT' ||
        options.failureKind === 'TIMEOUT' ||
        options.failureKind === 'MODEL_UNAVAILABLE' ||
        options.failureKind === 'MALFORMED_STRUCTURED_OUTPUT');
  }
}

export function mapHttpStatusToFailureKind(status: number): ProviderFailureKind {
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 401 || status === 403) return 'AUTH_OR_CONFIG_ERROR';
  if (status === 404 || status === 410) return 'MODEL_UNAVAILABLE';
  if (status === 400 || status === 422) return 'UNSUPPORTED_CAPABILITY';
  return 'TEMPORARY_PROVIDER_FAILURE';
}

export function normalizeProviderError(
  err: unknown,
  providerId: string,
  modelId: string
): ProviderAdapterError {
  if (err instanceof ProviderAdapterError) {
    return err;
  }

  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    const isAbortOrTimeout =
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      lower.includes('timed out') ||
      lower.includes('timeout') ||
      lower.includes('aborted');

    if (isAbortOrTimeout) {
      return new ProviderAdapterError({
        providerId,
        modelId,
        failureKind: 'TIMEOUT',
        message: `${providerId}/${modelId} request timed out.`,
        retryable: true,
        cause: err,
      });
    }

    if (lower.includes('rate limit') || lower.includes('429')) {
      return new ProviderAdapterError({
        providerId,
        modelId,
        failureKind: 'RATE_LIMIT',
        message: `${providerId}/${modelId} rate limit encountered.`,
        retryable: true,
        httpStatus: 429,
        cause: err,
      });
    }

    return new ProviderAdapterError({
      providerId,
      modelId,
      failureKind: 'TEMPORARY_PROVIDER_FAILURE',
      message: `${providerId}/${modelId} provider error: ${err.message}`,
      retryable: true,
      cause: err,
    });
  }

  return new ProviderAdapterError({
    providerId,
    modelId,
    failureKind: 'TEMPORARY_PROVIDER_FAILURE',
    message: `${providerId}/${modelId} encountered an unknown provider failure.`,
    retryable: true,
  });
}

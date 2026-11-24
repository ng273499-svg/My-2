/**
 * =============================================================================
 * JARVIS-X v1.1.0 — Professional Coding & Software Engineering Engine
 * Type contracts for the coding engine, integrated with JarvisCoreRuntime.
 * =============================================================================
 */

import type {
  CapabilityExecutionResult,
  CapabilityExecutionContext,
  RuntimeCapabilityId,
  RuntimeSpecialistId,
  RiskLevel,
  RuntimeState,
  RuntimeVerificationStatus,
  TaskType,
} from '@/core/types';

/** ---------------------------------------------------------------------------
 * 1. Coding task input / output
 * -------------------------------------------------------------------------- */

export type CodingTaskMode =
  | 'analyze'            // read-only repository analysis
  | 'feature'            // add a feature
  | 'debug'              // fix a build/test/runtime failure
  | 'refactor'           // bounded refactor with regression checks
  | 'implement-api'      // implement a server route / API
  | 'review';            // defensive security + code review

/**
 * Authorized document evidence retrieved from the v1.2 Grounded Document
 * Intelligence engine. Specs, ADRs and requirements are UNTRUSTED DATA: they
 * inform planning, they never grant authority or override policy.
 */
export interface SpecEvidence {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  /** Verified structural location (page/range/section) — never invented. */
  locationLabel: string;
  excerpt: string;
  trustLevel: string;
}

/** Bounded spec retriever injected by the caller (owner-scoped). */
export type SpecRetriever = (
  goal: string,
  options: { projectId: string | null }
) => Promise<SpecEvidence[]>;

export interface CodingTaskInput {
  goal: string;
  conversationId?: string;
  projectId?: string | null;
  mode: CodingTaskMode;
  authorizedWorkspace: string; // absolute workspace root path
  verificationPreference: 'strict' | 'standard' | 'minimal';
  /** Skip spawning toolchain version probes (used by the in-chat capability bridge). */
  skipToolchainDetection?: boolean;
  /** Operator-supplied repair bound; clamped to [0, 10] by the engine. */
  maxRepairIterations?: number;
  signal?: AbortSignal;
  /**
   * Optional authorized spec/requirements retrieval (v1.2). When supplied, the
   * planner grounds its plan in real, cited document evidence.
   */
  specRetriever?: SpecRetriever;
}

export interface CodingTaskResult {
  taskId: string;
  mode: CodingTaskMode;
  status: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'FAILED';
  planSummary: string;
  filesInspected: string[];
  changedFiles: string[];
  commandsExecuted: Array<{
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    riskLevel: CommandRisk;
    redactedSecrets: number;
  }>;
  testEvidence: {
    typecheckPassed: boolean;
    testPassed: boolean;
    buildPassed: boolean;
    testCount?: number;
    failingTests?: string[];
  };
  repairAttempts: number;
  verificationStatus: RuntimeVerificationStatus;
  warnings: string[];
  errors: string[];
  secretRedactions: number;
  repositoryProfile?: RepositoryProfile;
  /** Authorized spec evidence used during planning (v1.2 integration). */
  specEvidence?: SpecEvidence[];
}

/** ---------------------------------------------------------------------------
 * 2. Repository intelligence
 * -------------------------------------------------------------------------- */

export interface LanguageInfo {
  name: string;
  confidence: number; // 0..1
  fileCount: number;
  totalBytes: number;
}

export interface FrameworkInfo {
  name: string;
  confidence: number;
  evidence: string[]; // files or config that indicate the framework
}

export interface ToolchainInfo {
  name: string;
  status: 'AVAILABLE' | 'PARTIAL' | 'NOT_INSTALLED' | 'UNSUPPORTED';
  version?: string;
  detectedBy: string[]; // config files / binaries that indicate it
}

export interface RepositoryProfile {
  repositoryRoot: string;
  languages: LanguageInfo[];
  primaryLanguage: string | null;
  frameworks: FrameworkInfo[];
  importantDirectories: string[];
  entryPoints: string[];
  apisRoutes: string[];
  modulesComponents: string[];
  tests: string[];
  databaseMigrations: string[];
  packageConfig: string[];
  dependencies: Array<{ name: string; version?: string; dev: boolean }>;
  environmentVariableReferences: string[];
  documentation: string[];
  gitMetadata?: {
    currentBranch: string | null;
    recentCommits: Array<{ hash: string; message: string; date: string }>;
    statusSummary: string;
  };
  ignoredDirectories: string[];
  scannedAt: string;
}

/** ---------------------------------------------------------------------------
 * 3. Code search
 * -------------------------------------------------------------------------- */

export type CodeSearchKind =
  | 'filename'
  | 'exact-text'
  | 'symbol'
  | 'import-export'
  | 'dependency'
  | 'related-test'
  | 'configuration';

export interface CodeSearchQuery {
  kind: CodeSearchKind;
  pattern: string;
  pathScope?: string[]; // relative paths to limit search
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface CodeSearchResult {
  kind: CodeSearchKind;
  pattern: string;
  matches: Array<{
    file: string;
    line?: number;
    column?: number;
    context?: string;
    symbol?: string;
    isDefinition?: boolean;
  }>;
  totalMatches: number;
  truncated: boolean;
}

/** ---------------------------------------------------------------------------
 * 4. Code structure & dependency graph
 * -------------------------------------------------------------------------- */

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'module' | 'import' | 'export' | 'route' | 'schema' | 'test';
  file: string;
  line: number;
  signature?: string;
}

export interface DependencyEdge {
  from: string; // file
  to: string; // file or package
  type: 'import' | 'export' | 'dependency' | 'route';
}

export interface CodeStructureAnalysis {
  symbols: CodeSymbol[];
  dependencies: DependencyEdge[];
  blastRadiusEstimate: Array<{
    file: string;
    affectedBy: string[];
    riskScore: number; // 0..100
  }>;
}

/** ---------------------------------------------------------------------------
 * 5. File operations
 * -------------------------------------------------------------------------- */

export type FileOpKind = 'READ' | 'CREATE' | 'PATCH' | 'RENAME' | 'DELETE';

export interface FileOpResult {
  kind: FileOpKind;
  path: string;
  success: boolean;
  previousContent?: string;
  newContent?: string;
  bytesChanged?: number;
  error?: string;
}

/** ---------------------------------------------------------------------------
 * 6. Change record & rollback
 * -------------------------------------------------------------------------- */

export interface ChangeRecord {
  changeId: string;
  timestamp: string;
  kind: FileOpKind;
  path: string;
  previousHash?: string;
  newHash?: string;
  previousContent?: string;
  newContent?: string;
  reverted: boolean;
}

export interface ChangeLog {
  changes: ChangeRecord[];
  canRollback: (changeId: string) => boolean;
  rollback: (changeId: string) => Promise<{ success: boolean; error?: string }>;
}

/** ---------------------------------------------------------------------------
 * 7. Terminal execution
 * -------------------------------------------------------------------------- */

export type CommandRisk = 'SAFE_READ' | 'LOW_RISK' | 'CONFIRMATION_REQUIRED' | 'SENSITIVE';

export interface CommandProposal {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  riskLevel: CommandRisk;
  reason: string;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  riskLevel: CommandRisk;
  redactedSecrets: number;
}

/** ---------------------------------------------------------------------------
 * 8. Debugging / error parsing
 * -------------------------------------------------------------------------- */

export interface ParsedError {
  file: string | null;
  line: number | null;
  column: number | null;
  symbol: string | null;
  category: 'typescript' | 'compiler' | 'test' | 'lint' | 'build' | 'runtime' | 'dependency' | 'unknown';
  message: string;
  command: string | null;
  exitCode: number | null;
  relatedFiles: string[];
}

/** ---------------------------------------------------------------------------
 * 9. Repair loop
 * -------------------------------------------------------------------------- */

export interface RepairAttempt {
  attempt: number;
  trigger: string; // e.g. 'typecheck_failure', 'test_failure', 'build_failure'
  diagnosis: string;
  patch: FileOpResult[];
  revalidation: {
    typecheckPassed: boolean;
    testPassed: boolean;
    buildPassed: boolean;
  };
}

export interface RepairLoopConfig {
  maxIterations: number;
  timeoutPerIterationMs: number;
}

/** ---------------------------------------------------------------------------
 * 10. Specialist agents
 * -------------------------------------------------------------------------- */

export type EngineeringSpecialist =
  | 'SoftwareArchitectAgent'
  | 'RepositoryAnalystAgent'
  | 'ImplementationAgent'
  | 'DebuggingAgent'
  | 'TestEngineerAgent'
  | 'CodeReviewAgent'
  | 'SecurityReviewAgent'
  | 'DocumentationAgent';

export interface SpecialistAssignment {
  specialist: EngineeringSpecialist;
  task: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  result?: string;
}

/** ---------------------------------------------------------------------------
 * 11. Observability
 * -------------------------------------------------------------------------- */

export interface CodingObservabilityEvent {
  eventId: string;
  timestamp: string;
  taskId: string;
  mode: CodingTaskMode;
  language: string | null;
  toolchain: string | null;
  phase: 'understand' | 'inspect' | 'plan' | 'risk_check' | 'edit' | 'validate' | 'test' | 'observe' | 'diagnose' | 'repair' | 'retest' | 'verify';
  filesInspected: number;
  filesModified: number;
  commandsExecuted: number;
  repairIterations: number;
  verificationStatus: RuntimeVerificationStatus;
  durationMs: number;
}

/** ---------------------------------------------------------------------------
 * 12. Coding capability execution result (bridge to JarvisCoreRuntime)
 * -------------------------------------------------------------------------- */

export interface CodingCapabilityExecutionResult extends CapabilityExecutionResult {
  codingTaskResult?: CodingTaskResult;
  repositoryProfile?: RepositoryProfile;
}

/** ---------------------------------------------------------------------------
 * 13. Project memory entry
 * -------------------------------------------------------------------------- */

export interface ProjectMemoryEntry {
  key: string;
  value: string;
  category: 'architecture_decision' | 'framework' | 'important_module' | 'coding_convention' | 'verified_fix' | 'build_command' | 'test_strategy';
  source: string;
  timestamp: string;
}

/** ---------------------------------------------------------------------------
 * 14. Security review findings
 * -------------------------------------------------------------------------- */

export interface SecurityFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'hardcoded_secret' | 'unsafe_command' | 'dangerous_eval' | 'sql_injection' | 'xss' | 'auth_regression' | 'rls_weakening' | 'path_traversal' | 'unsafe_upload' | 'exposed_credential';
  file: string;
  line?: number;
  description: string;
  remediation: string;
}

/** ---------------------------------------------------------------------------
 * 15. Prompt-injection boundary result
 * -------------------------------------------------------------------------- */

export interface PromptInjectionBoundaryResult {
  injectionAttemptDetected: boolean;
  detectedPatterns: string[];
  sanitizedContent: string;
}
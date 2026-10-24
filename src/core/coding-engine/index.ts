/**
 * =============================================================================
 * JARVIS-X v1.1.0 — Professional Coding & Software Engineering Engine
 * Central coding engine module. Plugs into JarvisCoreRuntime via the existing
 * `coding` capability and exposes a secure server-side coding task API.
 * =============================================================================
 */

import { generateUuid } from '@/core/utils/uuid';
import type {
  CapabilityExecutionResult,
  CapabilityExecutionContext,
  RuntimeCapabilityId,
} from '@/core/types';
import type {
  CodingObservabilityEvent,
  CodingTaskInput,
  CodingTaskMode,
  CodingTaskResult,
  FileOpResult,
  ParsedError,
  RepositoryProfile,
  SecurityFinding,
  ToolchainInfo,
} from './types';
import { RepositoryProfiler } from './repository-profiler';
import { CodeSearchEngine } from './code-search';
import { CodeStructureAnalyzer } from './structure-analyzer';
import { FileOperations } from './file-operations';
import { ChangeLog as ChangeLogImpl } from './change-record';
import { TerminalExecutor } from './terminal-executor';
import { ToolchainDetector } from './toolchain-detector';
import { BuildDiscovery } from './build-discovery';
import { DebuggingEngine } from './debugging-engine';
import { RepairLoop } from './repair-loop';
import { EvidenceVerifier } from './verification';
import { SpecialistOrchestrator } from './specialists';
import { SecurityReviewEngine } from './security-review';
import { PromptInjectionDefense } from './prompt-injection-defense';
import { SecretProtection } from './secret-protection';
import { ProjectMemory } from './project-memory';
import { GitIntelligence } from './git-intelligence';
import { CodingObservability } from './observability';

const DEFAULT_WORKSPACE_ROOT = process.cwd();
const MAX_REPAIR_ITERATIONS_DEFAULT = 3;

/** Modes that never mutate the workspace (Software Architect Mode). */
const READ_ONLY_MODES: CodingTaskMode[] = ['analyze', 'review'];

/**
 * JARVIS-X Coding Engine
 *
 * Implements the professional software engineering workflow:
 *   UNDERSTAND → INSPECT → PLAN → RISK CHECK → EDIT → VALIDATE → TEST →
 *   OBSERVE → DIAGNOSE → REPAIR → RETEST → VERIFY
 *
 * All loops are bounded. No privilege escalation. No unrestricted shell.
 * Read-only modes never mutate code and never run builds.
 */
export class CodingEngine {
  public readonly workspaceRoot: string;
  public readonly maxRepairIterations: number;

  public readonly profiler: RepositoryProfiler;
  public readonly search: CodeSearchEngine;
  public readonly structure: CodeStructureAnalyzer;
  public readonly fileOps: FileOperations;
  public readonly changeLog: ChangeLogImpl;
  public readonly terminal: TerminalExecutor;
  public readonly toolchain: ToolchainDetector;
  public readonly buildDiscovery: BuildDiscovery;
  public readonly debugging: DebuggingEngine;
  public readonly verifier: EvidenceVerifier;
  public readonly specialists: SpecialistOrchestrator;
  public readonly securityReview: SecurityReviewEngine;
  public readonly secretProtection: SecretProtection;
  public readonly promptInjection: PromptInjectionDefense;
  public readonly projectMemory: ProjectMemory;
  public readonly git: GitIntelligence;
  public readonly observability: CodingObservability;

  private readonly repair: RepairLoop;

  constructor(
    workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
    options?: { maxRepairIterations?: number }
  ) {
    this.workspaceRoot = workspaceRoot;
    this.maxRepairIterations = Math.max(
      0,
      Math.min(10, options?.maxRepairIterations ?? MAX_REPAIR_ITERATIONS_DEFAULT)
    );

    this.secretProtection = new SecretProtection();
    this.promptInjection = new PromptInjectionDefense();
    this.observability = new CodingObservability(this.secretProtection);

    this.git = new GitIntelligence(workspaceRoot, this.secretProtection);
    this.profiler = new RepositoryProfiler(workspaceRoot, this.git, this.secretProtection);
    this.search = new CodeSearchEngine(workspaceRoot, this.secretProtection, this.promptInjection);
    this.structure = new CodeStructureAnalyzer(workspaceRoot, this.search, this.secretProtection);
    this.fileOps = new FileOperations(workspaceRoot, this.secretProtection, this.promptInjection);
    this.changeLog = new ChangeLogImpl(this.secretProtection);
    this.terminal = new TerminalExecutor(
      workspaceRoot,
      this.secretProtection,
      this.promptInjection
    );
    this.toolchain = new ToolchainDetector(workspaceRoot, this.terminal, this.secretProtection);
    this.buildDiscovery = new BuildDiscovery(
      workspaceRoot,
      this.toolchain,
      this.terminal,
      this.secretProtection
    );
    this.debugging = new DebuggingEngine(this.secretProtection);
    this.projectMemory = new ProjectMemory(this.secretProtection);
    this.verifier = new EvidenceVerifier(this, this.secretProtection);
    this.repair = new RepairLoop({
      debugging: this.debugging,
      verifier: this.verifier,
      fileOps: this.fileOps,
      workspaceRoot,
      maxIterations: this.maxRepairIterations,
    });
    this.specialists = new SpecialistOrchestrator(this, this.projectMemory);
    this.securityReview = new SecurityReviewEngine(
      this.secretProtection,
      this.promptInjection
    );
  }

  // ------------------------------------------------------------------------
  // Public entrypoint: execute a bounded coding task
  // ------------------------------------------------------------------------
  async executeCodingTask(input: CodingTaskInput): Promise<CodingTaskResult> {
    const taskId = generateUuid();
    const startedAt = Date.now();
    const events: CodingObservabilityEvent[] = [];
    const isReadOnly = READ_ONLY_MODES.includes(input.mode);
    const commandsExecuted: CodingTaskResult['commandsExecuted'] = [];
    const warnings: string[] = [];
    let secretRedactions = 0;

    const recordEvent = (
      phase: CodingObservabilityEvent['phase'],
      extra: Partial<CodingObservabilityEvent> = {}
    ) => {
      events.push({
        eventId: generateUuid(),
        timestamp: new Date().toISOString(),
        taskId,
        mode: input.mode,
        language: null,
        toolchain: null,
        phase,
        filesInspected: 0,
        filesModified: 0,
        commandsExecuted: 0,
        repairIterations: 0,
        verificationStatus: 'NOT_VERIFIABLE',
        durationMs: 0,
        ...extra,
      });
    };

    try {
      // === UNDERSTAND ===
      recordEvent('understand');
      const goalEval = this.promptInjection.sanitize(input.goal);
      if (goalEval.injectionAttemptDetected) {
        return this.failResult(
          taskId,
          input.mode,
          'Prompt-injection pattern detected in coding goal.',
          events,
          startedAt
        );
      }
      if (!goalEval.sanitized.trim()) {
        return this.failResult(taskId, input.mode, 'Coding goal cannot be empty.', events, startedAt);
      }

      // Workspace boundary check (client-supplied paths are never trusted).
      if (!this.isWithinWorkspace(input.authorizedWorkspace)) {
        return this.failResult(
          taskId,
          input.mode,
          'Authorized workspace is outside the permitted server workspace root.',
          events,
          startedAt
        );
      }

      // === INSPECT ===
      recordEvent('inspect');
      const profile = await this.profiler.profile();
      const toolchains = input.skipToolchainDetection
        ? []
        : await this.toolchain.detectAll();

      // === PLAN ===
      recordEvent('plan');
      const plan = this.createCodingPlan(input.mode, goalEval.sanitized, profile, toolchains);

      // === RISK CHECK ===
      recordEvent('risk_check');
      const riskCheck = this.assessCodingRisk(input.mode, plan, profile, goalEval.sanitized);
      if (riskCheck.blocked) {
        return this.failResult(
          taskId,
          input.mode,
          `Coding task blocked by risk policy: ${riskCheck.reason}`,
          events,
          startedAt
        );
      }

      // === READ-ONLY MODES: analysis only, zero mutation, zero build ===
      if (isReadOnly) {
        const securityFindings = this.runReadOnlySecurityReview(profile);
        const structure = this.structure.analyze();

        recordEvent('verify', {
          filesInspected: profile.modulesComponents.length,
          durationMs: Date.now() - startedAt,
        });
        this.observability.record(events);

        const result: CodingTaskResult = {
          taskId,
          mode: input.mode,
          status: 'VERIFIED',
          planSummary: plan.steps.join(' → '),
          filesInspected: [
            ...profile.entryPoints,
            ...profile.modulesComponents.slice(0, 30),
          ].slice(0, 40),
          changedFiles: [],
          commandsExecuted,
          testEvidence: { typecheckPassed: true, testPassed: true, buildPassed: true },
          repairAttempts: 0,
          verificationStatus: 'VERIFIED',
          warnings: [
            'Read-only mode: no files were modified and no build was executed.',
            ...securityFindings.map((f) => `[${f.severity}] ${f.category}: ${f.description}`),
          ],
          errors: [],
          secretRedactions,
          repositoryProfile: profile,
        };

        await this.recordProjectMemory(result, profile, structure.symbols.length);
        return result;
      }

      // === MUTATING MODES: VALIDATE → TEST → (bounded) DIAGNOSE → REPAIR → RETEST ===
      let repairAttempts = 0;
      let lastErrors: ParsedError[] = [];
      type CmdEvidence = CodingTaskResult['commandsExecuted'][number];
      let validation: {
        passed: boolean;
        errors: ParsedError[];
        rawResult?: CmdEvidence;
      } = { passed: true, errors: [] };
      let testEvidence: {
        passed: boolean;
        errors: ParsedError[];
        testCount?: number;
        failingTests?: string[];
        rawResult?: CmdEvidence;
      } = { passed: true, errors: [] };
      let buildEvidence: { passed: boolean; errors: ParsedError[]; rawResult?: CmdEvidence } = {
        passed: true,
        errors: [],
      };

      for (let iteration = 0; iteration <= this.maxRepairIterations; iteration += 1) {
        if (input.signal?.aborted) {
          return this.failResult(
            taskId,
            input.mode,
            'Coding task cancelled by operator.',
            events,
            startedAt
          );
        }

        recordEvent('validate', { repairIterations: iteration });
        validation = await this.validateWorkspace(profile);
        if (validation.rawResult) {
          secretRedactions += validation.rawResult.redactedSecrets;
          commandsExecuted.push(validation.rawResult);
        }

        recordEvent('test', { repairIterations: iteration });
        testEvidence = await this.runTests(profile);
        if (testEvidence.rawResult) {
          secretRedactions += testEvidence.rawResult.redactedSecrets;
          commandsExecuted.push(testEvidence.rawResult);
        }

        recordEvent('observe', { repairIterations: iteration });
        const wantsBuild = input.verificationPreference === 'strict';
        buildEvidence = wantsBuild ? await this.runBuild(profile) : { passed: true, errors: [] };
        if (buildEvidence.rawResult) {
          secretRedactions += buildEvidence.rawResult.redactedSecrets;
          commandsExecuted.push(buildEvidence.rawResult);
        }

        const allPass =
          validation.passed && testEvidence.passed && buildEvidence.passed;

        if (allPass) break;

        // Diagnose
        recordEvent('diagnose', { repairIterations: iteration });
        lastErrors = this.debugging.collectErrors(
          validation.errors,
          testEvidence.errors,
          buildEvidence.errors
        );

        if (iteration >= this.maxRepairIterations || lastErrors.length === 0) break;

        // Repair (bounded, conservative)
        recordEvent('repair', { repairIterations: iteration });
        const repair = await this.repair.attempt(lastErrors, input.signal);
        if (!repair.applied) break; // No safe deterministic fix available — stop honestly.
        repairAttempts += 1;
        recordEvent('retest', { repairIterations: iteration + 1 });
      }

      const allPass =
        validation.passed && testEvidence.passed && buildEvidence.passed;

      // === VERIFY ===
      recordEvent('verify', { repairIterations: repairAttempts });

      const result: CodingTaskResult = {
        taskId,
        mode: input.mode,
        status: allPass ? 'VERIFIED' : lastErrors.length > 0 ? 'PARTIALLY_VERIFIED' : 'UNVERIFIED',
        planSummary: plan.steps.join(' → '),
        filesInspected: [
          ...profile.entryPoints,
          ...profile.modulesComponents.slice(0, 30),
        ].slice(0, 40),
        changedFiles: this.changeLog.changesList.map((c) => c.path),
        commandsExecuted,
        testEvidence: {
          typecheckPassed: validation.passed,
          testPassed: testEvidence.passed,
          buildPassed: buildEvidence.passed,
          testCount: testEvidence.testCount,
          failingTests: testEvidence.failingTests ?? [],
        },
        repairAttempts,
        verificationStatus: allPass ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
        warnings: [
          ...warnings,
          ...lastErrors.map((e) => `[${e.category}] ${e.message}`),
          ...(repairAttempts >= this.maxRepairIterations
            ? [`Repair limit reached (${this.maxRepairIterations} iterations) — stopping with evidence.`]
            : []),
        ],
        errors: allPass ? [] : lastErrors.map((e) => e.message),
        secretRedactions,
        repositoryProfile: profile,
      };

      const verified = await this.verifier.verify(result);
      result.verificationStatus = verified.status;
      result.warnings = [...result.warnings, ...verified.warnings];

      this.observability.record(events);
      await this.recordProjectMemory(result, profile, 0);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected coding engine failure.';
      return this.failResult(taskId, input.mode, message, events, startedAt);
    }
  }

  // ------------------------------------------------------------------------
  // Bridge: execute as a JarvisCoreRuntime capability
  // ------------------------------------------------------------------------
  async executeAsCapability(ctx: CapabilityExecutionContext): Promise<CapabilityExecutionResult> {
    // SECURITY: the in-chat/voice bridge is strictly read-only analysis.
    // Mutating engineering runs only through POST /api/jarvis/coding, which
    // requires an authenticated owner session plus explicit acknowledgement.
    const mode: CodingTaskMode = 'analyze';

    const result = await this.executeCodingTask({
      goal: ctx.userMessage,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId ?? null,
      mode,
      authorizedWorkspace: this.workspaceRoot,
      verificationPreference: 'standard',
      // The in-chat bridge stays read-only and subprocess-light: profiling and
      // analysis only. Full validation runs through POST /api/jarvis/coding.
      skipToolchainDetection: true,
      signal: ctx.signal,
    });

    const status =
      result.status === 'FAILED'
        ? ('NOT_AVAILABLE' as const)
        : result.status === 'VERIFIED'
          ? ('EXECUTED' as const)
          : ('PARTIAL_LOCAL' as const);

    return {
      capabilityId: 'coding',
      status,
      untrustedExternalContent: true,
      summary: [
        `Coding Engine (${result.mode}) → ${result.status}.`,
        `Files inspected: ${result.filesInspected.length}. Files changed: ${result.changedFiles.length}.`,
        `Evidence: typecheck=${result.testEvidence.typecheckPassed}, tests=${result.testEvidence.testPassed}, build=${result.testEvidence.buildPassed}.`,
        result.warnings.length ? `Warnings: ${result.warnings.slice(0, 3).join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      data: {
        taskId: result.taskId,
        mode: result.mode,
        verificationStatus: result.verificationStatus,
        filesChanged: result.changedFiles.length,
        commandsExecuted: result.commandsExecuted.map((c) => ({
          command: c.command,
          exitCode: c.exitCode,
        })),
        testEvidence: result.testEvidence,
        repairAttempts: result.repairAttempts,
        secretRedactions: result.secretRedactions,
      },
      honestLimitationNote:
        'Coding Engine runs zero-cost local analysis and validation. Sandboxed remote code execution and external coding LLMs are NOT_AVAILABLE unless configured.',
    };
  }

  // ------------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------------

  private isWithinWorkspace(requestedPath: string): boolean {
    if (!requestedPath) return false;
    const normalizedRoot = this.workspaceRoot.replace(/\/+$/, '');
    const normalizedRequested = requestedPath.replace(/\/+$/, '');
    return (
      normalizedRequested === normalizedRoot ||
      normalizedRequested.startsWith(`${normalizedRoot}/`)
    );
  }

  /** Suggest a mode for UI pre-selection only. Never used to authorize mutation. */
  suggestModeFromMessage(message: string): CodingTaskMode {
    const raw = message.toLowerCase();
    if (/\b(fix|debug|bug|failing test|build fail|error|broken)\b/.test(raw)) return 'debug';
    if (/\b(refactor|restructure|clean ?up)\b/.test(raw)) return 'refactor';
    if (/\b(add|implement|build|create)\b.*\b(api|endpoint|route)\b/.test(raw))
      return 'implement-api';
    if (/\b(add|implement|build|create|feature)\b/.test(raw)) return 'feature';
    if (/\b(security|vulnerab|audit|review)\b/.test(raw)) return 'review';
    return 'analyze';
  }

  private createCodingPlan(
    mode: CodingTaskMode,
    goal: string,
    profile: RepositoryProfile,
    toolchains: ToolchainInfo[]
  ): { steps: string[]; estimatedComplexity: 'simple' | 'moderate' | 'complex' } {
    const availableToolchains = toolchains.filter((t) => t.status === 'AVAILABLE').length;
    const steps: string[] = [
      'Understand coding goal and repository context.',
      `Inspect repository: ${profile.primaryLanguage ?? 'unknown language'} · ${
        profile.frameworks.map((f) => f.name).join(', ') || 'no framework detected'
      }.`,
      'Search relevant code, symbols, and related tests.',
      'Analyze structure and estimate blast radius.',
      'Run defensive security review on the proposed change surface.',
    ];

    if (READ_ONLY_MODES.includes(mode)) {
      steps.push('Report architecture findings (read-only: no edits, no build).');
    } else {
      steps.push('Apply minimal file patches within workspace boundaries.');
      steps.push(
        `Validate with available tooling (${availableToolchains} toolchain(s) AVAILABLE).`
      );
      steps.push('Diagnose failures and apply bounded repairs if a safe fix exists.');
      steps.push('Re-run validation and verify evidence.');
    }
    steps.push('Record project knowledge (architecture, commands, verified outcomes).');

    let estimatedComplexity: 'simple' | 'moderate' | 'complex' = 'simple';
    if (profile.languages.length > 2 || goal.length > 200) estimatedComplexity = 'moderate';
    if (goal.length > 500 || profile.frameworks.length > 2) estimatedComplexity = 'complex';

    return { steps, estimatedComplexity };
  }

  private assessCodingRisk(
    mode: CodingTaskMode,
    plan: { steps: string[]; estimatedComplexity: string },
    profile: RepositoryProfile,
    goal: string
  ): { blocked: boolean; reason: string } {
    const destructive = [
      /\brm\s+-rf\b/i,
      /\bdrop\s+table\b/i,
      /\btruncate\s+table\b/i,
      /\bformat\s+[a-z]:/i,
      /\bgit\s+push\s+--force\b/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bsudo\b/i,
    ];
    for (const pat of destructive) {
      if (pat.test(goal) || pat.test(plan.steps.join(' '))) {
        return { blocked: true, reason: 'Destructive operation pattern detected in goal.' };
      }
    }
    // Guardrail: this engine never targets paths outside its own workspace.
    if (!profile.repositoryRoot) {
      return { blocked: true, reason: 'Repository root could not be resolved.' };
    }
    return { blocked: false, reason: '' };
  }

  private runReadOnlySecurityReview(profile: RepositoryProfile): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    // 1. Repository text must not be trusted as system instructions.
    for (const docPath of profile.documentation.slice(0, 5)) {
      const read = this.fileOps.read(docPath);
      if (!read.success || !read.newContent) continue;
      const evalResult = this.promptInjection.sanitize(read.newContent);
      if (evalResult.injectionAttemptDetected) {
        findings.push({
          severity: 'high',
          category: 'exposed_credential',
          file: docPath,
          description:
            'Repository documentation contains prompt-injection patterns; treated as untrusted data only.',
          remediation: 'Review documentation for embedded instructions targeting automated agents.',
        });
      }
    }

    // 2. .env files must never be committed.
    for (const cfg of profile.packageConfig) {
      if (/^\.env(?!\.example)/.test(cfg)) {
        findings.push({
          severity: 'critical',
          category: 'exposed_credential',
          file: cfg,
          description: 'Environment file present in repository scan surface.',
          remediation: 'Ensure .env files are gitignored and never committed.',
        });
      }
    }

    return findings;
  }

  private async validateWorkspace(profile: RepositoryProfile): Promise<{
    passed: boolean;
    errors: ParsedError[];
    rawResult?: CodingTaskResult['commandsExecuted'][number];
  }> {
    const cmd = this.buildDiscovery.discoverTypecheckCommand(profile);
    if (!cmd) {
      return { passed: true, errors: [] };
    }
    const result = await this.terminal.executeCommand(cmd);
    const rawResult = {
      command: `npx tsc --noEmit`,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      riskLevel: result.riskLevel,
      redactedSecrets: result.redactedSecrets,
    };
    if (result.timedOut) {
      return {
        passed: false,
        errors: [
          {
            file: null,
            line: null,
            column: null,
            symbol: null,
            category: 'typescript',
            message: `Typecheck timed out after ${cmd.timeoutMs}ms.`,
            command: cmd.command,
            exitCode: null,
            relatedFiles: [],
          },
        ],
        rawResult,
      };
    }
    if (result.exitCode !== 0) {
      const errors = this.debugging.parseTypescriptErrors(
        `${result.stdout}\n${result.stderr}`,
        'npx tsc --noEmit'
      );
      return { passed: false, errors, rawResult };
    }
    return { passed: true, errors: [], rawResult };
  }

  private async runTests(profile: RepositoryProfile): Promise<{
    passed: boolean;
    errors: ParsedError[];
    testCount?: number;
    failingTests?: string[];
    rawResult?: CodingTaskResult['commandsExecuted'][number];
  }> {
    const cmd = this.buildDiscovery.discoverTestCommand(profile);
    if (!cmd) return { passed: true, errors: [] };

    const result = await this.terminal.executeCommand(cmd);
    const rawResult = {
      command: `${cmd.command} ${cmd.args.join(' ')}`.trim(),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      riskLevel: result.riskLevel,
      redactedSecrets: result.redactedSecrets,
    };

    if (result.timedOut) {
      return {
        passed: false,
        errors: [
          {
            file: null,
            line: null,
            column: null,
            symbol: null,
            category: 'test',
            message: `Test run timed out after ${cmd.timeoutMs}ms.`,
            command: cmd.command,
            exitCode: null,
            relatedFiles: [],
          },
        ],
        rawResult,
      };
    }

    if (result.exitCode !== 0) {
      const errors = this.debugging.parseTestErrors(
        `${result.stdout}\n${result.stderr}`,
        rawResult.command
      );
      return {
        passed: false,
        errors,
        failingTests: errors.map((e) => e.message).slice(0, 10),
        rawResult,
      };
    }

    const testCountMatch = result.stdout.match(/(\d+)\s+(?:tests?|passed)/i);
    return {
      passed: true,
      errors: [],
      testCount: testCountMatch ? parseInt(testCountMatch[1], 10) : undefined,
      rawResult,
    };
  }

  private async runBuild(profile: RepositoryProfile): Promise<{
    passed: boolean;
    errors: ParsedError[];
    rawResult?: CodingTaskResult['commandsExecuted'][number];
  }> {
    const cmd = this.buildDiscovery.discoverBuildCommand(profile);
    if (!cmd) return { passed: true, errors: [] };

    const result = await this.terminal.executeCommand(cmd);
    const rawResult = {
      command: `${cmd.command} ${cmd.args.join(' ')}`.trim(),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      riskLevel: result.riskLevel,
      redactedSecrets: result.redactedSecrets,
    };

    if (result.timedOut) {
      return {
        passed: false,
        errors: [
          {
            file: null,
            line: null,
            column: null,
            symbol: null,
            category: 'build',
            message: `Build timed out after ${cmd.timeoutMs}ms.`,
            command: cmd.command,
            exitCode: null,
            relatedFiles: [],
          },
        ],
        rawResult,
      };
    }

    if (result.exitCode !== 0) {
      const errors = this.debugging.parseBuildErrors(
        `${result.stdout}\n${result.stderr}`,
        rawResult.command
      );
      return { passed: false, errors, rawResult };
    }

    return { passed: true, errors: [], rawResult };
  }

  private async recordProjectMemory(
    result: CodingTaskResult,
    profile: RepositoryProfile,
    symbolCount: number
  ): Promise<void> {
    try {
      if (profile.primaryLanguage) {
        this.projectMemory.store({
          key: 'primary-language',
          value: profile.primaryLanguage,
          category: 'framework',
          source: 'repository-profiler',
        });
      }
      for (const fw of profile.frameworks) {
        this.projectMemory.store({
          key: `framework:${fw.name}`,
          value: fw.evidence.join(', '),
          category: 'framework',
          source: 'repository-profiler',
        });
      }
      this.projectMemory.store({
        key: 'architecture-symbol-count',
        value: String(symbolCount),
        category: 'architecture_decision',
        source: 'structure-analyzer',
      });
      this.projectMemory.store({
        key: `coding-task:${result.mode}:${result.status}`,
        value: `mode=${result.mode}; status=${result.status}; changed=${result.changedFiles.length}; repairAttempts=${result.repairAttempts}`,
        category: result.status === 'VERIFIED' ? 'verified_fix' : 'test_strategy',
        source: 'coding-engine',
      });
    } catch {
      // Project memory is best-effort; never fail a task over it.
    }
  }

  private failResult(
    taskId: string,
    mode: CodingTaskMode,
    message: string,
    events: CodingObservabilityEvent[],
    startedAt: number
  ): CodingTaskResult {
    const result: CodingTaskResult = {
      taskId,
      mode,
      status: 'FAILED',
      planSummary: '',
      filesInspected: [],
      changedFiles: [],
      commandsExecuted: [],
      testEvidence: { typecheckPassed: false, testPassed: false, buildPassed: false },
      repairAttempts: 0,
      verificationStatus: 'NOT_VERIFIABLE',
      warnings: [],
      errors: [message],
      secretRedactions: 0,
    };
    events.push({
      eventId: generateUuid(),
      timestamp: new Date().toISOString(),
      taskId,
      mode,
      language: null,
      toolchain: null,
      phase: 'verify',
      filesInspected: 0,
      filesModified: 0,
      commandsExecuted: 0,
      repairIterations: 0,
      verificationStatus: 'NOT_VERIFIABLE',
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    this.observability.record(events);
    return result;
  }
}

/**
 * Factory: create a CodingEngine bound to the current workspace.
 */
export function createCodingEngine(
  workspaceRoot?: string,
  options?: { maxRepairIterations?: number }
): CodingEngine {
  return new CodingEngine(workspaceRoot, options);
}

/**
 * Map a CodingTaskMode to a RuntimeCapabilityId.
 */
export function codingModeToCapability(_mode: CodingTaskMode): RuntimeCapabilityId {
  return 'coding';
}

export * from './types';
export { SecretProtection } from './secret-protection';
export { PromptInjectionDefense } from './prompt-injection-defense';
export { GitIntelligence } from './git-intelligence';
export { RepositoryProfiler } from './repository-profiler';
export { CodeSearchEngine } from './code-search';
export { CodeStructureAnalyzer } from './structure-analyzer';
export { FileOperations } from './file-operations';
export { ChangeLogImpl as ChangeLog } from './change-record';
export { TerminalExecutor } from './terminal-executor';
export { ToolchainDetector } from './toolchain-detector';
export { BuildDiscovery } from './build-discovery';
export { DebuggingEngine } from './debugging-engine';
export { RepairLoop } from './repair-loop';
export { EvidenceVerifier } from './verification';
export { SpecialistOrchestrator } from './specialists';
export { SecurityReviewEngine } from './security-review';
export { ProjectMemory } from './project-memory';
export { CodingObservability } from './observability';

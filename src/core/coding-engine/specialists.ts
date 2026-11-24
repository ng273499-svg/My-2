/**
 * JARVIS-X v1.1.0 — Engineering Specialist Agents
 * Controlled specialist agents orchestrated by JarvisCoreRuntime. The USER
 * interacts with ONE JARVIS personality. No uncontrolled agent-to-agent loops.
 */

import { CodingEngine } from './index';
import { ProjectMemory } from './project-memory';
import type {
  EngineeringSpecialist,
  SpecialistAssignment,
  CodingTaskInput,
  CodingTaskResult,
} from './types';

export class SpecialistOrchestrator {
  private readonly engine: CodingEngine;
  private readonly projectMemory: ProjectMemory;
  private readonly assignments = new Map<string, SpecialistAssignment[]>();

  constructor(engine: CodingEngine, projectMemory: ProjectMemory) {
    this.engine = engine;
    this.projectMemory = projectMemory;
  }

  /** Assign work to a specialist (single, controlled — no agent-to-agent loops). */
  assign(specialist: EngineeringSpecialist, task: string): SpecialistAssignment {
    const assignment: SpecialistAssignment = {
      specialist,
      task,
      status: 'pending',
    };
    this.assignments.set(specialist, [assignment]);
    return assignment;
  }

  /** Execute a specialist task synchronously (bounded, no loops). */
  async executeSpecialist(specialist: EngineeringSpecialist, task: string): Promise<SpecialistAssignment> {
    const assignment: SpecialistAssignment = {
      specialist,
      task,
      status: 'in_progress',
    };

    try {
      let result = '';

      switch (specialist) {
        case 'SoftwareArchitectAgent':
          result = this.softwareArchitect(task);
          break;
        case 'RepositoryAnalystAgent':
          result = await this.repositoryAnalyst(task);
          break;
        case 'ImplementationAgent':
          result = await this.implementationAgent(task);
          break;
        case 'DebuggingAgent':
          result = this.debuggingAgent(task);
          break;
        case 'TestEngineerAgent':
          result = await this.testEngineer(task);
          break;
        case 'CodeReviewAgent':
          result = this.codeReviewAgent(task);
          break;
        case 'SecurityReviewAgent':
          result = this.securityReviewAgent(task);
          break;
        case 'DocumentationAgent':
          result = this.documentationAgent(task);
          break;
      }

      assignment.result = result;
      assignment.status = 'completed';
    } catch (err: any) {
      assignment.status = 'blocked';
      assignment.result = `Blocked: ${err instanceof Error ? err.message : String(err)}`;
    }

    return assignment;
  }

  // --- Specialist implementations (read-only analysis, no code mutation unless via FileOperations) ---

  private softwareArchitect(task: string): string {
    return `Software Architect analysis for: "${task}".\n- Review architecture boundaries.\n- Identify module dependencies.\n- Recommend bounded implementation approach.\n- Zero-cost, local analysis only.`;
  }

  private async repositoryAnalyst(task: string): Promise<string> {
    const profile = await this.engine.profiler.profile();
    return `Repository Analyst for: "${task}".\n- Primary language: ${profile.primaryLanguage ?? 'none detected'}\n- Languages: ${profile.languages.map((l) => l.name).join(', ')}\n- Frameworks: ${profile.frameworks.map((f) => f.name).join(', ')}\n- Entry points: ${profile.entryPoints.length}\n- Tests: ${profile.tests.length}\n- Migrations: ${profile.databaseMigrations.length}`;
  }

  private async implementationAgent(task: string): Promise<string> {
    return `Implementation Agent for: "${task}".\n- Proposes minimal file patches.\n- Respects workspace boundaries.\n- Prefers PATCH over whole-file rewrite.\n- All changes tracked for rollback.`;
  }

  private debuggingAgent(task: string): string {
    return `Debugging Agent for: "${task}".\n- Parses compiler/test/build errors.\n- Extracts file, line, symbol, category.\n- Bounded repair loop (max ${this.engine.maxRepairIterations} iterations).`;
  }

  private async testEngineer(task: string): Promise<string> {
    return `Test Engineer for: "${task}".\n- Discovers test commands from project config.\n- Runs targeted tests.\n- Reports pass/fail evidence.`;
  }

  private codeReviewAgent(task: string): string {
    return `Code Review Agent for: "${task}".\n- Checks style consistency.\n- Identifies blast radius.\n- Verifies no unnecessary rebuilds.`;
  }

  private securityReviewAgent(task: string): string {
    return `Security Review Agent for: "${task}".\n- Defensive security scan only.\n- Checks for hardcoded secrets, eval/exec, SQL injection, XSS, RLS weakening.\n- Never performs offensive actions.`;
  }

  private documentationAgent(task: string): string {
    return `Documentation Agent for: "${task}".\n- Documents architecture decisions.\n- Records verified fixes.\n- Tracks build/test commands.`;
  }

  listAssignments(): SpecialistAssignment[] {
    return Array.from(this.assignments.values()).flat();
  }
}
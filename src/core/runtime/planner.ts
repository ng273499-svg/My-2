import { generateUuid } from '@/core/utils/uuid';
import type {
  RiskClassification,
  RuntimeCapabilityId,
  RuntimeExecutionLimits,
  RuntimeSpecialistId,
  TaskClassification,
  TaskPlan,
  TaskPlanStep,
  TaskType,
} from '@/core/types';
import { RuntimeExecutionError } from './errors';

export interface PlannerContract {
  createPlan(input: {
    taskId: string;
    message: string;
    taskClassification: TaskClassification;
    riskClassification: RiskClassification;
    limits: RuntimeExecutionLimits;
  }): TaskPlan;
  validatePlanDependencies(steps: TaskPlanStep[], maxSteps: number): TaskPlanStep[];
}

function mapTaskToCapabilityAndSpecialist(
  taskType: TaskType,
  intent: string
): {
  capability: RuntimeCapabilityId;
  specialist?: RuntimeSpecialistId;
  expectedResult: string;
} {
  if (intent === 'diagnostics') {
    return {
      capability: 'verification',
      specialist: 'verification',
      expectedResult: 'Verified architectural & capability health summary.',
    };
  }
  if (intent === 'design') {
    return {
      capability: 'direct_conversation',
      specialist: 'design',
      expectedResult: 'Structured UI/UX layout & responsive ergonomics review.',
    };
  }

  switch (taskType) {
    case 'research':
      return {
        capability: 'research',
        specialist: 'research',
        expectedResult:
          'Research brief decomposition + transparent live-web connector availability report.',
      };
    case 'coding':
      return {
        capability: 'coding',
        specialist: 'coding',
        expectedResult:
          'Modular implementation blueprint + sandbox availability status.',
      };
    case 'planning':
      return {
        capability: 'direct_conversation',
        specialist: 'planning',
        expectedResult: 'Ordered milestone & dependency execution plan.',
      };
    case 'file_task':
      return {
        capability: 'file_intelligence',
        specialist: 'data',
        expectedResult: 'File intelligence capability status & schema readiness check.',
      };
    case 'knowledge_retrieval':
      return {
        capability: 'memory',
        specialist: 'memory',
        expectedResult: 'Permitted user/project memory recall or gated mutation readiness.',
      };
    case 'automation':
      return {
        capability: 'automation',
        specialist: 'automation',
        expectedResult: 'Confirmed workflow definition & scheduler availability status.',
      };
    case 'vision_task':
      return {
        capability: 'vision',
        specialist: 'vision',
        expectedResult: 'Visual frame metadata validation & Vision LLM connection status.',
      };
    case 'cybersecurity':
      return {
        capability: 'cybersecurity',
        specialist: 'cybersecurity',
        expectedResult: 'Defensive security posture, RLS & secret-hygiene assessment.',
      };
    case 'external_action':
      return {
        capability: 'external_tools',
        specialist: 'automation',
        expectedResult: 'Governance gate enforcement & external tool availability check.',
      };
    case 'conversation':
    default:
      return {
        capability: 'direct_conversation',
        expectedResult: 'Concise, grounded JARVIS-X response.',
      };
  }
}

/**
 * Structured Task Planner
 * Decomposes requests into explicit, dependency-checked `TaskPlanStep` nodes.
 * Never stores or emits private chain-of-thought — only concise user-facing objectives.
 */
export class StructuredTaskPlanner implements PlannerContract {
  createPlan(input: {
    taskId: string;
    message: string;
    taskClassification: TaskClassification;
    riskClassification: RiskClassification;
    limits: RuntimeExecutionLimits;
  }): TaskPlan {
    const { taskId, message, taskClassification, riskClassification, limits } = input;
    const primary = mapTaskToCapabilityAndSpecialist(
      taskClassification.taskType,
      taskClassification.intent
    );

    const steps: TaskPlanStep[] = [];

    if (taskClassification.strategy === 'multi_step_plan') {
      // Step 1: Primary capability / domain analysis
      const step1Id = 'step-1';
      steps.push({
        stepId: step1Id,
        order: 1,
        objective: `Execute primary ${taskClassification.taskType} analysis for "${message.slice(0, 64)}${message.length > 64 ? '…' : ''}"`,
        requiredCapability: primary.capability,
        specialistId: primary.specialist,
        dependencies: [],
        riskLevel: riskClassification.riskLevel,
        status: 'pending',
        expectedResult: primary.expectedResult,
        attempts: 0,
      });

      // Secondary domain steps (capped strictly within `limits.maxSteps - 1`)
      const maxSecondary = Math.max(0, limits.maxSteps - 2);
      const secondaryList = taskClassification.secondaryTaskTypes.slice(0, maxSecondary);

      let prevStepId = step1Id;
      secondaryList.forEach((secType, idx) => {
        const mapped = mapTaskToCapabilityAndSpecialist(secType, secType);
        const stepId = `step-${idx + 2}`;
        steps.push({
          stepId,
          order: idx + 2,
          objective: `Integrate ${secType} requirements & check ${mapped.capability} readiness`,
          requiredCapability: mapped.capability,
          specialistId: mapped.specialist,
          dependencies: [prevStepId],
          riskLevel: 'LOW_RISK',
          status: 'pending',
          expectedResult: mapped.expectedResult,
          attempts: 0,
        });
        prevStepId = stepId;
      });

      // Final synthesis & verification preparation step
      const finalOrder = steps.length + 1;
      if (finalOrder <= limits.maxSteps) {
        steps.push({
          stepId: `step-${finalOrder}`,
          order: finalOrder,
          objective: 'Synthesize consolidated execution roadmap and verify capability boundaries',
          requiredCapability: 'verification',
          specialistId: 'planning',
          dependencies: [prevStepId],
          riskLevel: 'READ_ONLY',
          status: 'pending',
          expectedResult: 'Structured multi-step response verified against capability registry.',
          attempts: 0,
        });
      }
    } else {
      steps.push({
        stepId: 'step-1',
        order: 1,
        objective:
          riskClassification.requiresApprovalPause
            ? `Evaluate ${riskClassification.riskLevel} governance policy before touching ${riskClassification.targetResource}`
            : `Execute ${primary.capability} handler (${taskClassification.strategy})`,
        requiredCapability: primary.capability,
        specialistId: primary.specialist,
        dependencies: [],
        riskLevel: riskClassification.riskLevel,
        status: 'pending',
        expectedResult: primary.expectedResult,
        attempts: 0,
      });
    }

    const validatedSteps = this.validatePlanDependencies(steps, limits.maxSteps);

    const conciseSummary =
      validatedSteps.length > 1
        ? `Built ${validatedSteps.length}-step execution plan (${taskClassification.taskType} · Risk: ${riskClassification.riskLevel}).`
        : `${taskClassification.summary} (Capability: ${primary.capability} · Risk: ${riskClassification.riskLevel}).`;

    return {
      planId: generateUuid(),
      taskId,
      strategy: taskClassification.strategy,
      conciseSummary,
      steps: validatedSteps,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Topological validation (Kahn's algorithm) ensuring:
   * 1. Step count never exceeds `maxSteps`
   * 2. Every dependency references a known stepId
   * 3. Zero cycles exist in the plan graph (prevents infinite planner loops)
   */
  validatePlanDependencies(steps: TaskPlanStep[], maxSteps: number): TaskPlanStep[] {
    if (steps.length > maxSteps) {
      throw new RuntimeExecutionError({
        code: 'STEP_LIMIT_EXCEEDED',
        message: `Planner generated ${steps.length} steps, exceeding maxSteps (${maxSteps}).`,
        retryable: false,
        failedState: 'PLANNING',
      });
    }

    const byId = new Map<string, TaskPlanStep>();
    for (const s of steps) {
      byId.set(s.stepId, s);
    }

    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const s of steps) {
      inDegree.set(s.stepId, 0);
      dependents.set(s.stepId, []);
    }

    for (const s of steps) {
      for (const depId of s.dependencies) {
        if (!byId.has(depId)) {
          throw new RuntimeExecutionError({
            code: 'PLAN_DEPENDENCY_CYCLE',
            message: `Plan step "${s.stepId}" depends on unknown step "${depId}".`,
            retryable: false,
            failedState: 'PLANNING',
          });
        }
        inDegree.set(s.stepId, (inDegree.get(s.stepId) ?? 0) + 1);
        dependents.get(depId)!.push(s.stepId);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const ordered: TaskPlanStep[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      ordered.push(byId.get(currentId)!);
      for (const childId of dependents.get(currentId) ?? []) {
        const nextDeg = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, nextDeg);
        if (nextDeg === 0) {
          queue.push(childId);
        }
      }
    }

    if (ordered.length !== steps.length) {
      throw new RuntimeExecutionError({
        code: 'PLAN_DEPENDENCY_CYCLE',
        message: 'Cyclic step dependency detected in execution plan; refusing to run unbounded loop.',
        retryable: false,
        failedState: 'PLANNING',
      });
    }

    return ordered.map((step, index) => ({
      ...step,
      order: index + 1,
    }));
  }
}

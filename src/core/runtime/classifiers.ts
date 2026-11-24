import type {
  ExecutionStrategy,
  InputModality,
  PermissionTier,
  RiskClassification,
  RiskLevel,
  RuntimeRequest,
  TaskClassification,
  TaskType,
} from '@/core/types';

export interface CustomTaskClassifierRule {
  id: string;
  taskType: TaskType;
  match: (message: string, request: RuntimeRequest) => boolean;
  strategy: ExecutionStrategy;
  intent?: string;
  confidence?: number;
}

/**
 * Extensible Task Classifier
 * Classifies incoming text, voice-transcript, and vision-ready requests into
 * structured task categories and determines the execution strategy without hard-coding
 * closed enums — custom rules can be registered at runtime.
 */
export class TaskClassifier {
  private customRules: CustomTaskClassifierRule[] = [];

  registerRule(rule: CustomTaskClassifierRule): void {
    this.customRules.unshift(rule);
  }

  private extractMemoryFact(message: string): string | undefined {
    const match = message.match(
      /(?:remember that|save to memory:?|store in memory:?|note that|remember)\s+(.+)/i
    );
    return match?.[1]?.trim();
  }

  private detectSecondaryTasks(message: string, primary: TaskType): TaskType[] {
    const secondary: TaskType[] = [];
    const checks: Array<{ type: TaskType; pattern: RegExp }> = [
      { type: 'research', pattern: /\b(research|investigate|compare sources|benchmark)\b/i },
      { type: 'coding', pattern: /\b(code|implement|typescript|python|refactor|schema|sql)\b/i },
      { type: 'planning', pattern: /\b(roadmap|architecture plan|milestone|step[- ]by[- ]step|breakdown|phase)\b/i },
      { type: 'cybersecurity', pattern: /\b(security|rls|threat model|vulnerability|audit|owasp|zero[- ]trust|defensive)\b/i },
      { type: 'knowledge_retrieval', pattern: /\b(what do you remember|recall|from memory|stored context)\b/i },
      { type: 'file_task', pattern: /\b(parse pdf|analyze file|read spreadsheet|csv|document ingestion)\b/i },
    ];

    for (const item of checks) {
      if (item.type !== primary && item.pattern.test(message)) {
        secondary.push(item.type);
      }
    }
    return secondary;
  }

  classify(request: RuntimeRequest): TaskClassification {
    const raw = request.message.trim();
    const modality: InputModality = request.visionAttachment
      ? 'vision_multimodal'
      : request.modality ?? (request.voiceInput ? 'voice_transcript' : 'text');

    // 1. Custom registered task rules first (extensibility hook)
    for (const rule of this.customRules) {
      if (rule.match(raw, request)) {
        return {
          taskType: rule.taskType,
          secondaryTaskTypes: [],
          intent: rule.intent ?? rule.taskType,
          strategy: rule.strategy,
          modality,
          complexity: rule.strategy === 'multi_step_plan' ? 'complex' : 'moderate',
          confidence: rule.confidence ?? 0.9,
          summary: `Classified as custom task "${rule.taskType}" (${rule.strategy}).`,
        };
      }
    }

    const isMultiClause =
      raw.length > 110 ||
      /\b(first\b.*\bthen\b|step 1|1\)|and also|followed by|multi[- ]step|comprehensive plan)/i.test(
        raw
      );

    // 2. Vision-ready task
    if (
      request.visionAttachment ||
      /\b(camera|photo|image|vision|look at this|screenshot|inspect frame)\b/i.test(raw)
    ) {
      return {
        taskType: 'vision_task',
        secondaryTaskTypes: this.detectSecondaryTasks(raw, 'vision_task'),
        intent: 'vision_inquiry',
        strategy: isMultiClause ? 'multi_step_plan' : 'capability_tool',
        modality,
        complexity: isMultiClause ? 'complex' : 'moderate',
        confidence: 0.95,
        summary: 'Classified as vision-ready inspection task.',
      };
    }

    // 3. External / sensitive device or system action
    if (
      /\b(unlock|lock door|disarm|delete all|wipe|execute shell|run bash|transfer funds|smart[- ]?home|thermostat|lights on|lights off|browser control|send email|post to slack|webhook call)\b/i.test(
        raw
      )
    ) {
      const isMemClear = /\b(clear memories|wipe memory|delete memory)\b/i.test(raw);
      return {
        taskType: isMemClear ? 'knowledge_retrieval' : 'external_action',
        secondaryTaskTypes: [],
        intent: isMemClear ? 'memory_clear' : 'sensitive_action',
        strategy: 'capability_tool',
        modality,
        complexity: 'moderate',
        confidence: 0.96,
        summary: isMemClear
          ? 'Classified as destructive memory purge operation.'
          : 'Classified as external / device action requiring governance evaluation.',
      };
    }

    // 4. Memory / Knowledge retrieval & explicit memory storage
    if (/\b(clear memories|wipe memory|delete memory)\b/i.test(raw)) {
      return {
        taskType: 'knowledge_retrieval',
        secondaryTaskTypes: [],
        intent: 'memory_clear',
        strategy: 'capability_tool',
        modality,
        complexity: 'moderate',
        confidence: 0.95,
        summary: 'Classified as destructive memory clear request.',
      };
    }

    if (/\b(remember that|save to memory|store in memory|note that my|remember my)\b/i.test(raw)) {
      return {
        taskType: 'knowledge_retrieval',
        secondaryTaskTypes: [],
        intent: 'memory_write',
        strategy: 'capability_tool',
        modality,
        complexity: 'simple',
        confidence: 0.94,
        summary: 'Classified as explicit durable memory storage request.',
        extractedMemoryFact: this.extractMemoryFact(raw),
      };
    }

    if (/\b(what do you remember|list memories|memory status|recall|retrieve knowledge)\b/i.test(raw)) {
      return {
        taskType: 'knowledge_retrieval',
        secondaryTaskTypes: this.detectSecondaryTasks(raw, 'knowledge_retrieval'),
        intent: 'memory_read',
        strategy: 'specialist_agent',
        modality,
        complexity: 'simple',
        confidence: 0.92,
        summary: 'Classified as permitted memory/knowledge retrieval.',
      };
    }

    // 5. File intelligence task
    if (
      request.documentAttachment ||
      /\b(parse pdf|analyze file|analyze document|read csv|extract spreadsheet|ingest document|file intelligence|upload document)\b/i.test(
        raw
      )
    ) {
      return {
        taskType: 'file_task',
        secondaryTaskTypes: this.detectSecondaryTasks(raw, 'file_task'),
        intent: 'file_analysis',
        strategy: isMultiClause ? 'multi_step_plan' : 'capability_tool',
        modality,
        complexity: isMultiClause ? 'complex' : 'moderate',
        confidence: 0.91,
        summary: 'Classified as file intelligence / document analysis task.',
      };
    }

    // 6. Cybersecurity / defensive-security task
    if (
      /\b(cybersecurity|defensive security|threat model|security audit|rls policy|owasp|zero[- ]trust|hardening|cve|vulnerability review|exploit|hack into)\b/i.test(
        raw
      )
    ) {
      const secondary = this.detectSecondaryTasks(raw, 'cybersecurity');
      const complex = isMultiClause || secondary.length > 0;
      return {
        taskType: 'cybersecurity',
        secondaryTaskTypes: secondary,
        intent: 'cybersecurity_review',
        strategy: complex ? 'multi_step_plan' : 'specialist_agent',
        modality,
        complexity: complex ? 'complex' : 'moderate',
        confidence: 0.92,
        summary: 'Classified as defensive cybersecurity & posture review task.',
      };
    }

    // 7. Automation task
    if (/\b(automate|workflow|schedule task|cron|recurring job|trigger routine)\b/i.test(raw)) {
      return {
        taskType: 'automation',
        secondaryTaskTypes: this.detectSecondaryTasks(raw, 'automation'),
        intent: 'automation',
        strategy: isMultiClause ? 'multi_step_plan' : 'specialist_agent',
        modality,
        complexity: isMultiClause ? 'complex' : 'moderate',
        confidence: 0.9,
        summary: 'Classified as workflow automation staging task.',
      };
    }

    // 8. Explicit Planning / Multi-step Architecture breakdown
    if (
      /\b(create a plan|project plan|implementation roadmap|multi[- ]step plan|break down|execution plan|phased rollout)\b/i.test(
        raw
      )
    ) {
      const secondary = this.detectSecondaryTasks(raw, 'planning');
      return {
        taskType: 'planning',
        secondaryTaskTypes: secondary,
        intent: 'planning',
        strategy: 'multi_step_plan',
        modality,
        complexity: 'complex',
        confidence: 0.91,
        summary: 'Classified as structured multi-step planning request.',
      };
    }

    // 9. Research task
    if (/\b(research|investigate|compare sources|find papers|web search|literature review)\b/i.test(raw)) {
      const secondary = this.detectSecondaryTasks(raw, 'research');
      const complex = isMultiClause || secondary.length > 0;
      return {
        taskType: 'research',
        secondaryTaskTypes: secondary,
        intent: 'research',
        strategy: complex ? 'multi_step_plan' : 'specialist_agent',
        modality,
        complexity: complex ? 'complex' : 'moderate',
        confidence: 0.9,
        summary: 'Classified as research & source analysis task.',
      };
    }

    // 10. Coding task
    if (/\b(code|typescript|python|refactor|implement|api route|sql|bug|unit test|function)\b/i.test(raw)) {
      const secondary = this.detectSecondaryTasks(raw, 'coding');
      const complex = isMultiClause || secondary.length > 0;
      return {
        taskType: 'coding',
        secondaryTaskTypes: secondary,
        intent: 'coding',
        strategy: complex ? 'multi_step_plan' : 'specialist_agent',
        modality,
        complexity: complex ? 'complex' : 'moderate',
        confidence: 0.9,
        summary: 'Classified as software engineering / coding task.',
      };
    }

    // 11. Design / Voice / Diagnostics -> Conversation or Specialist
    if (/\b(design|ui|ux|wireframe|color palette|layout|typography)\b/i.test(raw)) {
      return {
        taskType: 'planning',
        secondaryTaskTypes: [],
        intent: 'design',
        strategy: 'specialist_agent',
        modality,
        complexity: 'moderate',
        confidence: 0.88,
        summary: 'Classified as UI/UX design & spatial planning review.',
      };
    }

    if (/\b(voice|microphone|speak aloud|tts|stt|barge[- ]?in)\b/i.test(raw)) {
      return {
        taskType: 'conversation',
        secondaryTaskTypes: [],
        intent: 'voice_inquiry',
        strategy: 'direct_response',
        modality,
        complexity: 'simple',
        confidence: 0.92,
        summary: 'Classified as Voice Engine diagnostic inquiry.',
      };
    }

    if (/\b(status|diagnostics|architecture|modules|capabilities|what works|connected)\b/i.test(raw)) {
      return {
        taskType: 'conversation',
        secondaryTaskTypes: [],
        intent: 'diagnostics',
        strategy: 'specialist_agent',
        modality,
        complexity: 'simple',
        confidence: 0.94,
        summary: 'Classified as read-only system diagnostics inquiry.',
      };
    }

    const isGreeting =
      /^(hi|hello|hey|good morning|good evening|greetings|jarvis)\b/i.test(raw) &&
      raw.length < 48;

    return {
      taskType: 'conversation',
      secondaryTaskTypes: isMultiClause ? this.detectSecondaryTasks(raw, 'conversation') : [],
      intent: isGreeting ? 'greeting' : 'general_assistance',
      strategy: isMultiClause ? 'multi_step_plan' : 'direct_response',
      modality,
      complexity: isMultiClause ? 'complex' : 'simple',
      confidence: 0.89,
      summary: isGreeting
        ? 'Classified as direct conversational greeting.'
        : 'Classified as direct conversational request.',
    };
  }
}

export function mapRiskToPermissionTier(risk: RiskLevel): PermissionTier {
  switch (risk) {
    case 'READ_ONLY':
    case 'LOW_RISK':
      return 'SAFE_READ';
    case 'CONFIRMATION_REQUIRED':
      return 'CONFIRMATION_REQUIRED';
    case 'SENSITIVE':
      return 'SENSITIVE_AUTH_REQUIRED';
  }
}

/**
 * Risk Classifier
 * Evaluates task classification and raw request signals into:
 * READ_ONLY, LOW_RISK, CONFIRMATION_REQUIRED, or SENSITIVE.
 * Never permits automatic execution of CONFIRMATION_REQUIRED or SENSITIVE actions.
 */
export class RiskClassifier {
  classify(
    task: TaskClassification,
    rawMessage: string
  ): RiskClassification {
    const trimmed = rawMessage.trim();

    // Defensive-only security boundary: reject offensive cyber requests
    if (
      task.taskType === 'cybersecurity' &&
      /\b(hack into|exploit target|steal credentials|bypass auth on|ddos|ransomware|keylogger)\b/i.test(
        trimmed
      )
    ) {
      return {
        riskLevel: 'SENSITIVE',
        mappedPermissionTier: 'SENSITIVE_AUTH_REQUIRED',
        requiresApprovalPause: false,
        requiresStepUpVerification: false,
        actionCode: 'OFFENSIVE_SECURITY_BLOCKED',
        targetResource: 'Cybersecurity Policy Boundary',
        rationale:
          'JARVIS-X cybersecurity module operates strictly for defensive posture, auditing, and hardening.',
        blockedOffensiveRequest: true,
      };
    }

    // SENSITIVE actions (device control, shell/computer control, destructive wipes)
    if (task.intent === 'sensitive_action') {
      return {
        riskLevel: 'SENSITIVE',
        mappedPermissionTier: 'SENSITIVE_AUTH_REQUIRED',
        requiresApprovalPause: true,
        requiresStepUpVerification: true,
        actionCode: 'EXTERNAL_SENSITIVE_EXECUTION',
        targetResource: trimmed.slice(0, 72),
        rationale:
          'External device actuation, shell/browser control, or credentialed external action is classified SENSITIVE.',
      };
    }

    if (task.intent === 'memory_clear') {
      return {
        riskLevel: 'SENSITIVE',
        mappedPermissionTier: 'SENSITIVE_AUTH_REQUIRED',
        requiresApprovalPause: true,
        requiresStepUpVerification: true,
        actionCode: 'MEMORY_PURGE_SENSITIVE',
        targetResource: 'All Session/Stored Memories',
        rationale: 'Destructive deletion of stored operator memories requires SENSITIVE step-up verification.',
      };
    }

    // CONFIRMATION_REQUIRED actions (persistent memory write, workflow automation, external writes)
    if (task.intent === 'memory_write') {
      return {
        riskLevel: 'CONFIRMATION_REQUIRED',
        mappedPermissionTier: 'CONFIRMATION_REQUIRED',
        requiresApprovalPause: true,
        requiresStepUpVerification: false,
        actionCode: 'MEMORY_STORE_WRITE',
        targetResource: 'Memory Store (Supabase / Session)',
        rationale: 'Mutating durable long-term memory requires explicit operator confirmation.',
      };
    }

    if (task.taskType === 'automation' || task.intent === 'automation') {
      return {
        riskLevel: 'CONFIRMATION_REQUIRED',
        mappedPermissionTier: 'CONFIRMATION_REQUIRED',
        requiresApprovalPause: true,
        requiresStepUpVerification: false,
        actionCode: 'WORKFLOW_AUTOMATION_STAGE',
        targetResource: 'Automation Pipeline',
        rationale: 'Scheduling or staging automated workflows requires operator confirmation.',
      };
    }

    if (task.taskType === 'external_action') {
      return {
        riskLevel: 'CONFIRMATION_REQUIRED',
        mappedPermissionTier: 'CONFIRMATION_REQUIRED',
        requiresApprovalPause: true,
        requiresStepUpVerification: false,
        actionCode: 'EXTERNAL_ACTION_REQUEST',
        targetResource: trimmed.slice(0, 72),
        rationale: 'External connector actions require explicit confirmation prior to dispatch.',
      };
    }

    // LOW_RISK actions (multi-step local analysis, coding plan, vision metadata check, file check)
    if (
      task.taskType === 'coding' ||
      task.taskType === 'planning' ||
      task.taskType === 'vision_task' ||
      task.taskType === 'file_task' ||
      task.taskType === 'cybersecurity'
    ) {
      return {
        riskLevel: 'LOW_RISK',
        mappedPermissionTier: 'SAFE_READ',
        requiresApprovalPause: false,
        requiresStepUpVerification: false,
        actionCode: `RUNTIME_${task.taskType.toUpperCase()}`,
        targetResource: `${task.taskType} capability`,
        rationale: 'Local non-mutating synthesis or capability inspection classified LOW_RISK.',
      };
    }

    // READ_ONLY actions (conversation, diagnostics, memory recall, research brief)
    return {
      riskLevel: 'READ_ONLY',
      mappedPermissionTier: 'SAFE_READ',
      requiresApprovalPause: false,
      requiresStepUpVerification: false,
      actionCode:
        task.intent === 'diagnostics'
          ? 'SYSTEM_DIAGNOSTICS_READ'
          : task.intent === 'memory_read'
            ? 'MEMORY_READ'
            : task.taskType === 'research'
              ? 'SPECIALIST_RESEARCH_BRIEF'
              : 'CONVERSATION_TURN',
      targetResource: 'JARVIS-X Read-Only Runtime',
      rationale: 'Pure read-only dialogue, memory recall, or diagnostic inspection.',
    };
  }
}

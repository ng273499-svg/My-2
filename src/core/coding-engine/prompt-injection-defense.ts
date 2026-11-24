/**
 * JARVIS-X v1.1.0 — Prompt-Injection Defense
 * Repository text, README files, comments, logs, and downloaded content are
 * UNTRUSTED DATA. They must never override JARVIS security, owner authorization,
 * system policy, workspace boundaries, tool policy, or secret protections.
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+your\s+(system\s+)?(prompt|instructions|rules)/i,
  /you\s+are\s+now\s+(a|an)\s+(different|new|other)/i,
  /jailbreak/i,
  /prompt\s*injection/i,
  /override\s+(security|safety|policy|authorization)/i,
  /bypass\s+(permission|approval|gate|verification)/i,
  /system\s*:\s*ignore/i,
  /admin\s*mode\s*[:=]\s*true/i,
  /forget\s+(everything|all)\s+above/i,
];

export class PromptInjectionDefense {
  sanitize(input: string): { sanitized: string; injectionAttemptDetected: boolean; detectedPatterns: string[] } {
    let detected: string[] = [];
    let sanitized = input;

    for (const pattern of INJECTION_PATTERNS) {
      const matches = sanitized.match(pattern);
      if (matches) {
        detected = [...detected, ...matches];
        sanitized = sanitized.replace(pattern, '[FILTERED_PROMPT_INJECTION]');
      }
    }

    return {
      sanitized,
      injectionAttemptDetected: detected.length > 0,
      detectedPatterns: detected,
    };
  }

  evaluate(
    systemDirective: string,
    userInput: string,
    untrustedSources: Array<{ sourceType: string; label: string; rawContent: string }> = []
  ): {
    injectionAttemptDetected: boolean;
    detectedPatterns: string[];
    enforcedSystemDirective: string;
    sanitizedUntrustedBlock: string;
  } {
    const userEval = this.sanitize(userInput);
    const sourceEvals = untrustedSources.map((s) => this.sanitize(s.rawContent));

    const allDetected = [
      ...userEval.detectedPatterns,
      ...sourceEvals.flatMap((e) => e.detectedPatterns),
    ];

    const sanitizedSources = untrustedSources.map((s, idx) => ({
      ...s,
      rawContent: sourceEvals[idx]?.sanitized ?? s.rawContent,
    }));

    const sanitizedUntrustedBlock = sanitizedSources
      .map((s) => `[${s.sourceType}] ${s.label}:\n${s.rawContent.slice(0, 2000)}`)
      .join('\n\n');

    return {
      injectionAttemptDetected: userEval.injectionAttemptDetected || sourceEvals.some((e) => e.injectionAttemptDetected),
      detectedPatterns: allDetected,
      enforcedSystemDirective: systemDirective,
      sanitizedUntrustedBlock,
    };
  }
}
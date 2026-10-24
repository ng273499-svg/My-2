/**
 * JARVIS-X v1.1.0 — Project Memory Integration
 * Retains useful project knowledge (architecture decisions, framework, modules,
 * conventions, verified fixes, build commands, test strategy). Never stores
 * secrets or huge raw repositories as permanent memory.
 */

import { SecretProtection } from './secret-protection';

export interface ProjectMemoryEntry {
  key: string;
  value: string;
  category:
    | 'architecture_decision'
    | 'framework'
    | 'important_module'
    | 'coding_convention'
    | 'verified_fix'
    | 'build_command'
    | 'test_strategy';
  source: string;
  timestamp: string;
}

export class ProjectMemory {
  private readonly secretProtection: SecretProtection;
  private readonly memory = new Map<string, ProjectMemoryEntry>();

  constructor(secretProtection: SecretProtection) {
    this.secretProtection = secretProtection;
  }

  store(entry: Omit<ProjectMemoryEntry, 'timestamp'>): void {
    const { sanitized: safeValue } = this.secretProtection.redact(entry.value);
    this.memory.set(entry.key, {
      ...entry,
      value: safeValue,
      timestamp: new Date().toISOString(),
    });
  }

  get(key: string): ProjectMemoryEntry | undefined {
    return this.memory.get(key);
  }

  listByCategory(category: ProjectMemoryEntry['category']): ProjectMemoryEntry[] {
    return Array.from(this.memory.values()).filter((e) => e.category === category);
  }

  listAll(): ProjectMemoryEntry[] {
    return Array.from(this.memory.values());
  }

  search(query: string): ProjectMemoryEntry[] {
    const q = query.toLowerCase();
    return Array.from(this.memory.values()).filter(
      (e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)
    );
  }

  clear(): void {
    this.memory.clear();
  }

  size(): number {
    return this.memory.size;
  }
}
/**
 * JARVIS-X v1.1.0 — Intelligent Code Search
 * Supports filename/path search, exact text search, symbol discovery,
 * import/export discovery, dependency/reference discovery, related-test discovery,
 * configuration discovery. Selects only task-relevant context.
 */

import fs from 'fs';
import path from 'path';
import { SecretProtection } from './secret-protection';
import { PromptInjectionDefense } from './prompt-injection-defense';
import type { CodeSearchQuery, CodeSearchResult } from './types';

const MAX_FILE_READ_BYTES = 200_000;
const MAX_RESULTS_DEFAULT = 50;

export class CodeSearchEngine {
  private readonly workspaceRoot: string;
  private readonly secretProtection: SecretProtection;
  private readonly promptInjection: PromptInjectionDefense;

  constructor(workspaceRoot: string, secretProtection: SecretProtection, promptInjection: PromptInjectionDefense) {
    this.workspaceRoot = workspaceRoot;
    this.secretProtection = secretProtection;
    this.promptInjection = promptInjection;
  }

  query(q: CodeSearchQuery): CodeSearchResult {
    // Prompt-injection boundary on the search pattern
    const patternEval = this.promptInjection.sanitize(q.pattern);
    if (patternEval.injectionAttemptDetected) {
      return {
        kind: q.kind,
        pattern: q.pattern,
        matches: [],
        totalMatches: 0,
        truncated: false,
      };
    }

    const pattern = patternEval.sanitized;
    const maxResults = q.maxResults ?? MAX_RESULTS_DEFAULT;
    const caseSensitive = q.caseSensitive ?? false;
    const pathScope = q.pathScope;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
    } catch {
      regex = /$/; // match nothing
    }

    const matches: CodeSearchResult['matches'] = [];
    let truncated = false;

    const walk = (dir: string): void => {
      if (truncated) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (truncated) break;
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.workspaceRoot, full);

        // Skip ignored directories
        if (entry.isDirectory()) {
          const ignored = ['node_modules', '.next', 'dist', 'build', 'coverage', '.git', '.turbo', '.nx', 'out', 'target'];
          if (ignored.includes(entry.name)) continue;
          if (entry.name.startsWith('.')) continue;
          walk(full);
          continue;
        }

        // Path scope filter
        if (pathScope && !pathScope.some((s) => rel.startsWith(s))) continue;

        // Filename search
        if (q.kind === 'filename') {
          if (regex.test(entry.name)) {
            matches.push({
              file: rel,
              context: `Filename match: ${entry.name}`,
            });
          }
          continue;
        }

        // Read file content for text/symbol/import searches
        const ext = path.extname(entry.name);
        if (['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.php', '.rb', '.kt', '.swift', '.dart', '.sh', '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.sql', '.html', '.css'].includes(ext)) {
          try {
            const stat = fs.statSync(full);
            if (stat.size > MAX_FILE_READ_BYTES) continue;
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n');

            if (q.kind === 'exact-text') {
              lines.forEach((line, lineIdx) => {
                if (regex.test(line)) {
                  matches.push({
                    file: rel,
                    line: lineIdx + 1,
                    context: line.trim().slice(0, 200),
                  });
                }
              });
            } else if (q.kind === 'symbol') {
              const symbolRegex = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+(\w+)/g;
              lines.forEach((line, lineIdx) => {
                let m: RegExpExecArray | null;
                while ((m = symbolRegex.exec(line)) !== null) {
                  if (regex.test(m[1])) {
                    matches.push({
                      file: rel,
                      line: lineIdx + 1,
                      symbol: m[1],
                      context: line.trim().slice(0, 200),
                      isDefinition: true,
                    });
                  }
                }
              });
            } else if (q.kind === 'import-export') {
              const importRegex = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
              lines.forEach((line, lineIdx) => {
                let m: RegExpExecArray | null;
                while ((m = importRegex.exec(line)) !== null) {
                  if (regex.test(m[1])) {
                    matches.push({
                      file: rel,
                      line: lineIdx + 1,
                      context: line.trim().slice(0, 200),
                    });
                  }
                }
              });
            } else if (q.kind === 'dependency') {
              const depRegex = /['"]([^'"]+)['"]/g;
              lines.forEach((line, lineIdx) => {
                let m: RegExpExecArray | null;
                while ((m = depRegex.exec(line)) !== null) {
                  if (regex.test(m[1])) {
                    matches.push({
                      file: rel,
                      line: lineIdx + 1,
                      context: line.trim().slice(0, 200),
                    });
                  }
                }
              });
            } else if (q.kind === 'related-test') {
              if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry.name) && regex.test(entry.name)) {
                matches.push({
                  file: rel,
                  context: `Test file: ${entry.name}`,
                });
              }
            } else if (q.kind === 'configuration') {
              if (/(config|\.env|package\.json|tsconfig|\.toml|\.yaml|\.yml)$/i.test(rel) && regex.test(rel)) {
                matches.push({
                  file: rel,
                  context: `Config file: ${rel}`,
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    };

    walk(this.workspaceRoot);

    // Redact secrets from all match contexts
    for (const m of matches) {
      if (m.context) {
        const { sanitized } = this.secretProtection.redact(m.context);
        m.context = sanitized;
      }
    }

    return {
      kind: q.kind,
      pattern: q.pattern,
      matches,
      totalMatches: matches.length,
      truncated,
    };
  }
}
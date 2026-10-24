/**
 * JARVIS-X v1.1.0 — Code Structure Intelligence
 * Extensible analysis for functions, classes, interfaces, types, modules,
 * imports, exports, routes, schemas, tests. Builds a lightweight dependency
 * graph so JARVIS can estimate blast radius before important edits.
 */

import fs from 'fs';
import path from 'path';
import { CodeSearchEngine } from './code-search';
import { SecretProtection } from './secret-protection';
import type { CodeSymbol, DependencyEdge, CodeStructureAnalysis } from './types';

export class CodeStructureAnalyzer {
  private readonly workspaceRoot: string;
  private readonly search: CodeSearchEngine;
  private readonly secretProtection: SecretProtection;

  constructor(workspaceRoot: string, search: CodeSearchEngine, secretProtection: SecretProtection) {
    this.workspaceRoot = workspaceRoot;
    this.search = search;
    this.secretProtection = secretProtection;
  }

  analyze(): CodeStructureAnalysis {
    const symbols: CodeSymbol[] = [];
    const dependencies: DependencyEdge[] = [];

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.workspaceRoot, full);

        if (entry.isDirectory()) {
          const ignored = ['node_modules', '.next', 'dist', 'build', 'coverage', '.git', '.turbo', '.nx', 'out', 'target'];
          if (ignored.includes(entry.name)) continue;
          if (entry.name.startsWith('.')) continue;
          walk(full);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cs', '.php', '.rb'].includes(ext)) continue;

        try {
          const stat = fs.statSync(full);
          if (stat.size > 500_000) continue;
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');

          // Extract symbols
          lines.forEach((line, idx) => {
            // Function
            const fnMatch = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
            if (fnMatch) {
              symbols.push({ name: fnMatch[1], kind: 'function', file: rel, line: idx + 1, signature: line.trim().slice(0, 120) });
            }
            // Class
            const clsMatch = line.match(/\b(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
            if (clsMatch) {
              symbols.push({ name: clsMatch[1], kind: 'class', file: rel, line: idx + 1, signature: line.trim().slice(0, 120) });
            }
            // Interface
            const ifaceMatch = line.match(/\b(?:export\s+)?interface\s+(\w+)/);
            if (ifaceMatch) {
              symbols.push({ name: ifaceMatch[1], kind: 'interface', file: rel, line: idx + 1, signature: line.trim().slice(0, 120) });
            }
            // Type
            const typeMatch = line.match(/\b(?:export\s+)?type\s+(\w+)/);
            if (typeMatch) {
              symbols.push({ name: typeMatch[1], kind: 'type', file: rel, line: idx + 1, signature: line.trim().slice(0, 120) });
            }
            // Import/export
            const impMatch = line.match(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
            if (impMatch) {
              dependencies.push({ from: rel, to: impMatch[1], type: 'import' });
            }
            const expMatch = line.match(/export\s+.*?\s+from\s+['"]([^'"]+)['"]/);
            if (expMatch) {
              dependencies.push({ from: rel, to: expMatch[1], type: 'export' });
            }
            // Routes (Next.js route.ts pattern)
            if (rel.includes('/route.ts') || rel.includes('/route.js')) {
              symbols.push({ name: 'API Route', kind: 'route', file: rel, line: idx + 1, signature: line.trim().slice(0, 120) });
            }
          });
        } catch {
          // Skip unreadable files
        }
      }
    };

    walk(this.workspaceRoot);

    // Build blast radius estimate
    const fileDepCount = new Map<string, number>();
    for (const dep of dependencies) {
      fileDepCount.set(dep.from, (fileDepCount.get(dep.from) ?? 0) + 1);
    }

    const blastRadius = Array.from(fileDepCount.entries()).map(([file, count]) => ({
      file,
      affectedBy: dependencies.filter((d) => d.to === file).map((d) => d.from),
      riskScore: Math.min(100, count * 10),
    }));

    return {
      symbols,
      dependencies,
      blastRadiusEstimate: blastRadius.slice(0, 50),
    };
  }

  estimateBlastRadius(filePath: string): { affectedFiles: string[]; riskScore: number } {
    const analysis = this.analyze();
    const affected: string[] = [];
    let riskScore = 0;

    for (const dep of analysis.dependencies) {
      if (dep.to === filePath || dep.to.includes(path.basename(filePath))) {
        affected.push(dep.from);
        riskScore += 10;
      }
      if (dep.from === filePath) {
        affected.push(dep.to);
        riskScore += 5;
      }
    }

    return { affectedFiles: [...new Set(affected)].slice(0, 30), riskScore: Math.min(100, riskScore) };
  }
}
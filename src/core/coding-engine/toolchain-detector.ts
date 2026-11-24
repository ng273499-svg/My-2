/**
 * JARVIS-X v1.1.0 — Toolchain Detection
 * Detects available tooling: Node/npm/pnpm/yarn, TypeScript, Python/pip,
 * Java/Javac, C/C++ compiler, .NET, Go, Rust/Cargo, PHP, Ruby, Dart/Flutter.
 * Does not automatically install large runtimes. Reports missing tooling truthfully.
 */

import fs from 'fs';
import path from 'path';
import { TerminalExecutor } from './terminal-executor';
import { SecretProtection } from './secret-protection';
import type { ToolchainInfo } from './types';

interface ToolchainProbe {
  name: string;
  binary: string;
  versionArgs: string[];
  configFiles: string[];
}

const TOOLCHAIN_PROBES: ToolchainProbe[] = [
  { name: 'Node.js', binary: 'node', versionArgs: ['--version'], configFiles: ['package.json', '.nvmrc'] },
  { name: 'npm', binary: 'npm', versionArgs: ['--version'], configFiles: ['package.json', 'package-lock.json'] },
  { name: 'pnpm', binary: 'pnpm', versionArgs: ['--version'], configFiles: ['pnpm-lock.yaml'] },
  { name: 'yarn', binary: 'yarn', versionArgs: ['--version'], configFiles: ['yarn.lock'] },
  { name: 'TypeScript', binary: 'tsc', versionArgs: ['--version'], configFiles: ['tsconfig.json'] },
  { name: 'Python', binary: 'python3', versionArgs: ['--version'], configFiles: ['pyproject.toml', 'requirements.txt', 'Pipfile'] },
  { name: 'pip', binary: 'pip3', versionArgs: ['--version'], configFiles: ['requirements.txt', 'Pipfile'] },
  { name: 'Java', binary: 'java', versionArgs: ['-version'], configFiles: ['pom.xml', 'build.gradle', '*.java'] },
  { name: 'Javac', binary: 'javac', versionArgs: ['-version'], configFiles: ['*.java', 'pom.xml', 'build.gradle'] },
  { name: 'GCC', binary: 'gcc', versionArgs: ['--version'], configFiles: ['Makefile', 'CMakeLists.txt', '*.c', '*.h'] },
  { name: 'G++', binary: 'g++', versionArgs: ['--version'], configFiles: ['Makefile', 'CMakeLists.txt', '*.cpp', '*.hpp'] },
  { name: '.NET', binary: 'dotnet', versionArgs: ['--version'], configFiles: ['*.csproj', '*.sln', 'Program.cs'] },
  { name: 'Go', binary: 'go', versionArgs: ['version'], configFiles: ['go.mod', 'go.sum', '*.go'] },
  { name: 'Rust/Cargo', binary: 'cargo', versionArgs: ['--version'], configFiles: ['Cargo.toml', 'Cargo.lock', '*.rs'] },
  { name: 'PHP', binary: 'php', versionArgs: ['--version'], configFiles: ['composer.json', '*.php'] },
  { name: 'Ruby', binary: 'ruby', versionArgs: ['--version'], configFiles: ['Gemfile', 'Gemfile.lock', '*.rb'] },
  { name: 'Dart', binary: 'dart', versionArgs: ['--version'], configFiles: ['pubspec.yaml', '*.dart'] },
  { name: 'CMake', binary: 'cmake', versionArgs: ['--version'], configFiles: ['CMakeLists.txt'] },
  { name: 'Make', binary: 'make', versionArgs: ['--version'], configFiles: ['Makefile'] },
];

export class ToolchainDetector {
  private readonly workspaceRoot: string;
  private readonly terminal: TerminalExecutor;
  private readonly secretProtection: SecretProtection;
  private cache: Map<string, ToolchainInfo> = new Map();

  constructor(workspaceRoot: string, terminal: TerminalExecutor, secretProtection: SecretProtection) {
    this.workspaceRoot = workspaceRoot;
    this.terminal = terminal;
    this.secretProtection = secretProtection;
  }

  async detectAll(): Promise<ToolchainInfo[]> {
    const results: ToolchainInfo[] = [];

    for (const probe of TOOLCHAIN_PROBES) {
      const info = await this.detectOne(probe);
      results.push(info);
      this.cache.set(probe.name, info);
    }

    // Also detect from config files present in workspace
    const configBased = this.detectFromConfigFiles();
    for (const info of configBased) {
      if (!this.cache.has(info.name)) {
        results.push(info);
        this.cache.set(info.name, info);
      }
    }

    return results.sort((a, b) => {
      const order: Record<string, number> = { AVAILABLE: 0, PARTIAL: 1, NOT_INSTALLED: 2, UNSUPPORTED: 3 };
      return (order[a.status] ?? 99) - (order[b.status] ?? 99);
    });
  }

  private async detectOne(probe: { name: string; binary: string; versionArgs: string[]; configFiles: string[] }): Promise<ToolchainInfo> {
    // Check if binary is available by attempting to run it
    try {
      const result = await this.terminal.executeCommand({
        command: probe.binary,
        args: probe.versionArgs,
        cwd: this.workspaceRoot,
        timeoutMs: 5000,
        riskLevel: 'SAFE_READ',
        reason: `Detect ${probe.name} toolchain version`,
      });

      if (result.exitCode === 0 && result.stdout.trim()) {
        return {
          name: probe.name,
          status: 'AVAILABLE',
          version: result.stdout.trim().split('\n')[0],
          detectedBy: [`binary:${probe.binary}`],
        };
      }
    } catch {
      // Binary not available
    }

    // Fall back to config file detection
    const configEvidence = probe.configFiles.filter((cf) => {
      try {
        return fs.existsSync(path.join(this.workspaceRoot, cf));
      } catch {
        return false;
      }
    });

    if (configEvidence.length > 0) {
      return {
        name: probe.name,
        status: 'PARTIAL',
        detectedBy: configEvidence.map((cf) => `config:${cf}`),
      };
    }

    return {
      name: probe.name,
      status: 'NOT_INSTALLED',
      detectedBy: [],
    };
  }

  private detectFromConfigFiles(): ToolchainInfo[] {
    const results: ToolchainInfo[] = [];

    // Detect package.json ecosystem
    try {
      if (fs.existsSync(path.join(this.workspaceRoot, 'package.json'))) {
        results.push({
          name: 'Node.js ecosystem',
          status: 'PARTIAL',
          detectedBy: ['config:package.json'],
        });
      }
    } catch {
      // Ignore
    }

    // Detect Cargo.toml
    try {
      if (fs.existsSync(path.join(this.workspaceRoot, 'Cargo.toml'))) {
        results.push({
          name: 'Rust/Cargo ecosystem',
          status: 'PARTIAL',
          detectedBy: ['config:Cargo.toml'],
        });
      }
    } catch {
      // Ignore
    }

    // Detect go.mod
    try {
      if (fs.existsSync(path.join(this.workspaceRoot, 'go.mod'))) {
        results.push({
          name: 'Go ecosystem',
          status: 'PARTIAL',
          detectedBy: ['config:go.mod'],
        });
      }
    } catch {
      // Ignore
    }

    // Detect pyproject.toml
    try {
      if (fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'))) {
        results.push({
          name: 'Python ecosystem',
          status: 'PARTIAL',
          detectedBy: ['config:pyproject.toml'],
        });
      }
    } catch {
      // Ignore
    }

    return results;
  }

  getCached(name: string): ToolchainInfo | undefined {
    return this.cache.get(name);
  }
}
/**
 * JARVIS-X v1.1.0 — Test/Build Discovery
 * Discovers commands from trusted project configuration: package.json,
 * pyproject.toml, Cargo.toml, go.mod, pom.xml, build.gradle, CMakeLists.txt,
 * Makefile, .NET project files. Supports lint, typecheck, unit tests,
 * integration tests, targeted tests, production build.
 */

import fs from 'fs';
import path from 'path';
import { ToolchainDetector } from './toolchain-detector';
import { TerminalExecutor } from './terminal-executor';
import { SecretProtection } from './secret-protection';
import type { RepositoryProfile, CommandProposal } from './types';

export class BuildDiscovery {
  private readonly workspaceRoot: string;
  private readonly toolchain: ToolchainDetector;
  private readonly terminal: TerminalExecutor;
  private readonly secretProtection: SecretProtection;

  constructor(workspaceRoot: string, toolchain: ToolchainDetector, terminal: TerminalExecutor, secretProtection: SecretProtection) {
    this.workspaceRoot = workspaceRoot;
    this.toolchain = toolchain;
    this.terminal = terminal;
    this.secretProtection = secretProtection;
  }

  discoverTestCommand(profile: RepositoryProfile): CommandProposal | null {
    // Node.js/vitest/jest
    if (profile.packageConfig.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8'));
        const scripts = pkg.scripts ?? {};
        if (scripts.test) {
          return this.terminal.propose('npm', ['test'], this.workspaceRoot, 'Run project test suite', 60000);
        }
        if (scripts['test:watch']) {
          // Skip watch mode — not suitable for automated validation
        }
      } catch {
        // Ignore parse errors
      }
      // Check if vitest is available
      const vitest = this.toolchain.getCached('vitest') ?? this.toolchain.getCached('TypeScript');
      if (vitest) {
        return this.terminal.propose('npx', ['vitest', 'run'], this.workspaceRoot, 'Run vitest test suite', 60000);
      }
    }

    // Python pytest
    if (profile.packageConfig.some((p) => p === 'pyproject.toml' || p === 'requirements.txt')) {
      return this.terminal.propose('python3', ['-m', 'pytest'], this.workspaceRoot, 'Run Python pytest suite', 60000);
    }

    // Rust cargo test
    if (profile.packageConfig.includes('Cargo.toml')) {
      return this.terminal.propose('cargo', ['test'], this.workspaceRoot, 'Run Rust cargo tests', 120000);
    }

    // Go test
    if (profile.packageConfig.includes('go.mod')) {
      return this.terminal.propose('go', ['test', './...'], this.workspaceRoot, 'Run Go tests', 120000);
    }

    // Java Maven
    if (profile.packageConfig.includes('pom.xml')) {
      return this.terminal.propose('mvn', ['test'], this.workspaceRoot, 'Run Maven tests', 120000);
    }

    // .NET
    if (profile.packageConfig.some((p) => p.endsWith('.csproj') || p.endsWith('.sln'))) {
      return this.terminal.propose('dotnet', ['test'], this.workspaceRoot, 'Run .NET tests', 120000);
    }

    return null;
  }

  discoverBuildCommand(profile: RepositoryProfile): CommandProposal | null {
    // Node.js/Next.js build
    if (profile.packageConfig.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8'));
        const scripts = pkg.scripts ?? {};
        if (scripts.build) {
          return this.terminal.propose('npm', ['run', 'build'], this.workspaceRoot, 'Run production build', 180000);
        }
      } catch {
        // Ignore
      }
    }

    // Rust cargo build
    if (profile.packageConfig.includes('Cargo.toml')) {
      return this.terminal.propose('cargo', ['build', '--release'], this.workspaceRoot, 'Run Rust release build', 180000);
    }

    // Go build
    if (profile.packageConfig.includes('go.mod')) {
      return this.terminal.propose('go', ['build', './...'], this.workspaceRoot, 'Run Go build', 120000);
    }

    // Java Maven
    if (profile.packageConfig.includes('pom.xml')) {
      return this.terminal.propose('mvn', ['package'], this.workspaceRoot, 'Run Maven package', 180000);
    }

    // .NET build
    if (profile.packageConfig.some((p) => p.endsWith('.csproj'))) {
      return this.terminal.propose('dotnet', ['build'], this.workspaceRoot, 'Run .NET build', 180000);
    }

    return null;
  }

  discoverLintCommand(profile: RepositoryProfile): CommandProposal | null {
    if (profile.packageConfig.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8'));
        const scripts = pkg.scripts ?? {};
        if (scripts.lint) {
          return this.terminal.propose('npm', ['run', 'lint'], this.workspaceRoot, 'Run linter', 60000);
        }
      } catch {
        // Ignore
      }
    }
    return null;
  }

  discoverTypecheckCommand(profile: RepositoryProfile): CommandProposal | null {
    const hasTsconfig =
      profile.packageConfig.includes('tsconfig.json') ||
      (() => {
        try {
          return fs.existsSync(path.join(this.workspaceRoot, 'tsconfig.json'));
        } catch {
          return false;
        }
      })();

    if (hasTsconfig) {
      return this.terminal.propose(
        'npx',
        ['tsc', '--noEmit'],
        this.workspaceRoot,
        'Run TypeScript typecheck',
        120_000
      );
    }
    return null;
  }
}
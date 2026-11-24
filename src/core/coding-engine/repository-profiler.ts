/**
 * JARVIS-X v1.1.0 — Repository Profiler
 * Builds a bounded RepositoryProfile: languages, frameworks, important dirs,
 * entry points, APIs/routes, modules, tests, database migrations, package config,
 * dependencies, env var references, documentation, git metadata.
 * Ignores generated/heavy directories: node_modules, .next, dist, build, coverage,
 * .git objects, large binaries/generated artifacts.
 */

import fs from 'fs';
import path from 'path';
import { GitIntelligence } from './git-intelligence';
import { SecretProtection } from './secret-protection';
import type { RepositoryProfile, LanguageInfo, FrameworkInfo, ToolchainInfo } from './types';

const IGNORED_DIRECTORIES = [
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.nx',
  'out',
  'target',
];

const IGNORED_FILE_PATTERNS = [
  /\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.png$/, /\.jpg$/, /\.jpeg$/, /\.gif$/, /\.ico$/, /\.svg$/,
  /\.woff$/, /\.woff2$/, /\.ttf$/, /\.eot$/,
  /\.zip$/, /\.tar\.gz$/, /\.rar$/,
];

const LANGUAGE_EXTENSIONS: Record<string, { name: string; weight: number }> = {
  '.ts': { name: 'TypeScript', weight: 2 },
  '.tsx': { name: 'TypeScript', weight: 2 },
  '.js': { name: 'JavaScript', weight: 1 },
  '.jsx': { name: 'JavaScript', weight: 1 },
  '.mjs': { name: 'JavaScript', weight: 1 },
  '.py': { name: 'Python', weight: 2 },
  '.java': { name: 'Java', weight: 2 },
  '.c': { name: 'C', weight: 2 },
  '.cpp': { name: 'C++', weight: 2 },
  '.cc': { name: 'C++', weight: 2 },
  '.cxx': { name: 'C++', weight: 2 },
  '.h': { name: 'C/C++', weight: 1 },
  '.hpp': { name: 'C++', weight: 1 },
  '.cs': { name: 'C#', weight: 2 },
  '.go': { name: 'Go', weight: 2 },
  '.rs': { name: 'Rust', weight: 2 },
  '.php': { name: 'PHP', weight: 2 },
  '.rb': { name: 'Ruby', weight: 2 },
  '.kt': { name: 'Kotlin', weight: 2 },
  '.swift': { name: 'Swift', weight: 2 },
  '.dart': { name: 'Dart', weight: 2 },
  '.sql': { name: 'SQL', weight: 1 },
  '.html': { name: 'HTML', weight: 1 },
  '.css': { name: 'CSS', weight: 1 },
  '.scss': { name: 'CSS (SCSS)', weight: 1 },
  '.less': { name: 'CSS (LESS)', weight: 1 },
  '.sh': { name: 'Shell/Bash', weight: 1 },
  '.bash': { name: 'Shell/Bash', weight: 1 },
  '.zsh': { name: 'Shell/Zsh', weight: 1 },
  '.ps1': { name: 'PowerShell', weight: 1 },
  '.json': { name: 'JSON', weight: 1 },
  '.yaml': { name: 'YAML', weight: 1 },
  '.yml': { name: 'YAML', weight: 1 },
  '.toml': { name: 'TOML', weight: 1 },
  '.xml': { name: 'XML', weight: 1 },
  '.md': { name: 'Markdown', weight: 1 },
  '.mdx': { name: 'Markdown (MDX)', weight: 1 },
};

const FRAMEWORK_HINTS: Record<string, { name: string; evidenceFiles: string[] }> = {
  'nextjs': { name: 'Next.js', evidenceFiles: ['next.config.mjs', 'next.config.js', 'next.config.ts'] },
  'react': { name: 'React', evidenceFiles: ['package.json'] },
  'vue': { name: 'Vue.js', evidenceFiles: ['vue.config.js', 'vite.config.js'] },
  'express': { name: 'Express.js', evidenceFiles: ['package.json'] },
  'nestjs': { name: 'NestJS', evidenceFiles: ['nest-cli.json'] },
  'django': { name: 'Django', evidenceFiles: ['manage.py', 'settings.py'] },
  'flask': { name: 'Flask', evidenceFiles: ['app.py', 'wsgi.py'] },
  'fastapi': { name: 'FastAPI', evidenceFiles: ['main.py', 'app.py'] },
  'spring': { name: 'Spring Boot', evidenceFiles: ['pom.xml', 'build.gradle'] },
  'ruby_on_rails': { name: 'Ruby on Rails', evidenceFiles: ['Gemfile', 'config/application.rb'] },
  'laravel': { name: 'Laravel', evidenceFiles: ['artisan', 'composer.json'] },
  'dotnet': { name: '.NET', evidenceFiles: ['*.csproj', '*.sln', 'Program.cs'] },
  'aspnet_core': { name: 'ASP.NET Core', evidenceFiles: ['Program.cs', 'Startup.cs'] },
};

const PACKAGE_CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next.config.mjs',
  'next.config.js',
  'vite.config.ts',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  '*.csproj',
  '*.sln',
  'Package.swift',
  'composer.json',
  'composer.lock',
  'mix.exs',
  'Gemfile',
  'Gemfile.lock',
];

const DATABASE_MIGRATION_PATTERNS = [
  /migration/i,
  /migrations/i,
  /\d{14}_/,
  /\.sql$/i,
];

const DOCUMENTATION_FILES = [
  'README.md',
  'README.txt',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'docs/',
  'documentation/',
];

const PROFILE_CACHE_TTL_MS = 30_000;

export class RepositoryProfiler {
  private readonly workspaceRoot: string;
  private readonly git: GitIntelligence;
  private readonly secretProtection: SecretProtection;
  private cachedProfile: { profile: RepositoryProfile; expiresAt: number } | null = null;

  constructor(workspaceRoot: string, git: GitIntelligence, secretProtection: SecretProtection) {
    this.workspaceRoot = workspaceRoot;
    this.git = git;
    this.secretProtection = secretProtection;
  }

  /** Invalidate the cached profile (call after workspace mutations). */
  invalidate(): void {
    this.cachedProfile = null;
  }

  async profile(): Promise<RepositoryProfile> {
    const now = Date.now();
    if (this.cachedProfile && this.cachedProfile.expiresAt > now) {
      return this.cachedProfile.profile;
    }
    const built = await this.buildProfile();
    this.cachedProfile = { profile: built, expiresAt: now + PROFILE_CACHE_TTL_MS };
    return built;
  }

  private async buildProfile(): Promise<RepositoryProfile> {
    const files = this.collectFiles();
    const languages = this.detectLanguages(files);
    const primaryLanguage = languages.length > 0 ? languages[0].name : null;
    const frameworks = this.detectFrameworks(files, languages);
    const importantDirectories = this.findImportantDirectories(files);
    const entryPoints = this.findEntryPoints(files, languages);
    const apisRoutes = this.findApiRoutes(files);
    const modulesComponents = this.findModulesComponents(files);
    const tests = this.findTestFiles(files);
    const databaseMigrations = this.findDatabaseMigrations(files);
    const packageConfig = this.findPackageConfig(files);
    const dependencies = this.extractDependencies(files);
    const envVarRefs = this.findEnvironmentVariableReferences(files);
    const documentation = this.findDocumentation(files);
    const ignoredDirs = [...IGNORED_DIRECTORIES];
    const gitMetadata = this.git.isRepository() ? this.collectGitMetadata() : undefined;

    return {
      repositoryRoot: this.workspaceRoot,
      languages,
      primaryLanguage,
      frameworks,
      importantDirectories,
      entryPoints,
      apisRoutes,
      modulesComponents,
      tests,
      databaseMigrations,
      packageConfig,
      dependencies,
      environmentVariableReferences: envVarRefs,
      documentation,
      gitMetadata,
      ignoredDirectories: ignoredDirs,
      scannedAt: new Date().toISOString(),
    };
  }

  private collectFiles(): Array<{ relPath: string; absPath: string; ext: string; size: number }> {
    const results: Array<{ relPath: string; absPath: string; ext: string; size: number }> = [];

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

        // Skip ignored directories
        if (entry.isDirectory()) {
          const dirName = entry.name;
          if (IGNORED_DIRECTORIES.includes(dirName)) continue;
          if (dirName.startsWith('.') && dirName !== '.github') continue;
          walk(full);
          continue;
        }

        // Skip ignored file patterns
        if (IGNORED_FILE_PATTERNS.some((p) => p.test(entry.name))) continue;

        // Skip dotfiles except known config
        if (entry.name.startsWith('.') && !PACKAGE_CONFIG_FILES.some((pc) => pc.startsWith('.') && entry.name.includes(pc.slice(1)))) continue;

        try {
          const stat = fs.statSync(full);
          const ext = path.extname(entry.name).toLowerCase();
          results.push({ relPath: rel, absPath: full, ext, size: stat.size });
        } catch {
          // Skip files that can't be stat'd
        }
      }
    };

    walk(this.workspaceRoot);
    return results;
  }

  private detectLanguages(files: Array<{ ext: string; size: number }>): LanguageInfo[] {
    const langStats = new Map<string, { name: string; count: number; bytes: number; weight: number }>();

    for (const f of files) {
      const info = LANGUAGE_EXTENSIONS[f.ext];
      if (!info) continue;
      const existing = langStats.get(info.name) ?? { name: info.name, count: 0, bytes: 0, weight: info.weight };
      existing.count += 1;
      existing.bytes += f.size;
      langStats.set(info.name, existing);
    }

    return Array.from(langStats.values())
      .map((v) => ({
        name: v.name,
        confidence: Math.min(0.99, (v.weight * v.count) / (files.length + 1)),
        fileCount: v.count,
        totalBytes: v.bytes,
      }))
      .sort((a, b) => b.fileCount - a.fileCount);
  }

  private detectFrameworks(files: Array<{ relPath: string }>, languages: LanguageInfo[]): FrameworkInfo[] {
    const found: FrameworkInfo[] = [];
    const fileNames = new Set(files.map((f) => f.relPath));
    const fileBaseNames = new Set(files.map((f) => path.basename(f.relPath)));

    for (const [key, hint] of Object.entries(FRAMEWORK_HINTS)) {
      const evidence: string[] = [];
      for (const ef of hint.evidenceFiles) {
        if (ef.includes('*')) {
          // Glob pattern
          const prefix = ef.replace('*', '');
          for (const fn of fileBaseNames) {
            if (fn.startsWith(prefix)) evidence.push(fn);
          }
        } else if (fileNames.has(ef) || fileBaseNames.has(ef)) {
          evidence.push(ef);
        }
      }
      if (evidence.length > 0) {
        found.push({ name: hint.name, confidence: Math.min(0.95, evidence.length / 3), evidence });
      }
    }
    return found;
  }

  private findImportantDirectories(files: Array<{ relPath: string }>): string[] {
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.relPath.split(path.sep);
      if (parts.length > 1) {
        dirs.add(parts[0]);
      }
    }
    return Array.from(dirs).sort();
  }

  private findEntryPoints(files: Array<{ relPath: string }>, languages: LanguageInfo[]): string[] {
    const entryPoints: string[] = [];
    const entryNames = ['index.ts', 'index.js', 'index.jsx', 'index.tsx', 'main.py', 'main.ts', 'main.js', 'app.ts', 'app.js', 'main.go', 'main.rs', 'Main.java', 'Program.cs', 'index.html'];

    for (const f of files) {
      const base = path.basename(f.relPath);
      if (entryNames.includes(base)) {
        entryPoints.push(f.relPath);
      }
    }
    return entryPoints.slice(0, 20);
  }

  private findApiRoutes(files: Array<{ relPath: string }>): string[] {
    const routes: string[] = [];
    const apiPatterns = ['api/', 'routes/', 'route.ts', 'route.js', 'controller'];

    for (const f of files) {
      const rel = f.relPath;
      if (apiPatterns.some((p) => rel.includes(p))) {
        routes.push(rel);
      }
    }
    return routes.slice(0, 50);
  }

  private findModulesComponents(files: Array<{ relPath: string }>): string[] {
    const components: string[] = [];
    const hints = ['components/', 'modules/', 'services/', 'core/', 'lib/', 'src/'];

    for (const f of files) {
      const rel = f.relPath;
      if (hints.some((h) => rel.startsWith(h) || rel.includes(`/${h}`))) {
        components.push(rel);
      }
    }
    return components.slice(0, 50);
  }

  private findTestFiles(files: Array<{ relPath: string }>): string[] {
    const tests: string[] = [];
    const testPatterns = [/\.(test|spec)\.(ts|tsx|js|jsx)$/, /__tests__\//, /test\//, /tests\//];

    for (const f of files) {
      if (testPatterns.some((p) => p.test(f.relPath))) {
        tests.push(f.relPath);
      }
    }
    return tests.slice(0, 50);
  }

  private findDatabaseMigrations(files: Array<{ relPath: string }>): string[] {
    const migrations: string[] = [];
    for (const f of files) {
      if (DATABASE_MIGRATION_PATTERNS.some((p) => p.test(f.relPath))) {
        migrations.push(f.relPath);
      }
    }
    return migrations.slice(0, 50);
  }

  private findPackageConfig(files: Array<{ relPath: string; absPath: string; ext: string; size: number }>): string[] {
    return files
      .filter((f) => PACKAGE_CONFIG_FILES.some((pc) => {
        if (pc.includes('*')) {
          const prefix = pc.replace('*', '');
          return f.relPath.startsWith(prefix) || f.relPath.endsWith(prefix.slice(0, -1));
        }
        return f.relPath === pc || path.basename(f.relPath) === pc;
      }))
      .map((f) => f.relPath)
      .slice(0, 50);
  }

  private extractDependencies(files: Array<{ relPath: string; absPath: string; ext: string; size: number }>): Array<{ name: string; version?: string; dev: boolean }> {
    const deps: Array<{ name: string; version?: string; dev: boolean }> = [];

    const pkgFile = files.find((f) => f.relPath === 'package.json');
    if (pkgFile) {
      try {
        const content = fs.readFileSync(pkgFile.absPath, 'utf8');
        const pkg = JSON.parse(content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [name, version] of Object.entries(allDeps)) {
          deps.push({ name, version: String(version), dev: Boolean(pkg.devDependencies?.[name]) });
        }
      } catch {
        // Ignore parse errors
      }
    }

    return deps.slice(0, 100);
  }

  private findEnvironmentVariableReferences(files: Array<{ relPath: string; absPath: string; ext: string; size: number }>): string[] {
    const refs: string[] = [];
    const envPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

    for (const f of files) {
      // Only scan source/config files, not lock files or binaries
      if (!['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.php', '.rb', '.env'].includes(f.ext)) continue;
      try {
        const content = fs.readFileSync(f.absPath, 'utf8');
        let match: RegExpExecArray | null;
        while ((match = envPattern.exec(content)) !== null) {
          refs.push(match[1]);
        }
      } catch {
        // Skip unreadable files
      }
    }

    return [...new Set(refs)].slice(0, 100);
  }

  private findDocumentation(files: Array<{ relPath: string }>): string[] {
    const docs: string[] = [];
    for (const f of files) {
      const base = path.basename(f.relPath).toLowerCase();
      const rel = f.relPath;
      if (base === 'readme.md' || base === 'readme.txt' || base === 'changelog.md' || base === 'contributing.md' || rel.startsWith('docs/') || rel.startsWith('documentation/')) {
        docs.push(rel);
      }
    }
    return docs.slice(0, 30);
  }

  private collectGitMetadata(): RepositoryProfile['gitMetadata'] {
    try {
      return {
        currentBranch: this.git.getCurrentBranch(),
        recentCommits: this.git.getRecentCommits(5),
        statusSummary: this.git.getStatus().statusSummary,
      };
    } catch {
      return {
        currentBranch: null,
        recentCommits: [],
        statusSummary: 'Git metadata unavailable.',
      };
    }
  }
}
/**
 * JARVIS-X v1.3.0 — Deep Research & Web Intelligence Engine
 *
 * One bounded orchestrator over eight specialist contracts. The pipeline is:
 *
 *   question → intent → scope → plan → queries → discovery → safety →
 *   fetch → extraction → normalization → evidence → claims → comparison →
 *   contradiction/freshness → follow-up → ranking → context → synthesis →
 *   claim verification → citation verification → report
 *
 * Invariants enforced here (not in documentation — in code):
 *   * Every stage checks for cancellation, and the whole run has a deadline.
 *   * The provider's `live` flag is carried into the report; a NON-LIVE run can
 *     never be presented as live web research.
 *   * Web content is neutralised before it reaches evidence, and `unknown` is a
 *     first-class outcome rather than a fabricated answer.
 *   * Owner isolation is enforced on every task lookup, cancel and history call.
 */

import {
  HARD_CEILING,
  clampBudget,
  type ClaimGraph,
  type Contradiction,
  type EvidenceUnit,
  type FactCheckResult,
  type FetchProviderLike,
  type FetchedPage,
  type ResearchFailureCode,
  type ResearchIntent,
  type ResearchMetrics,
  type ResearchPlan,
  type ResearchProgressEvent,
  type ResearchReport,
  type ResearchRequest,
  type ResearchResult,
  type ResearchStage,
  type ResearchTaskStatus,
  type SearchProviderHealth,
  type WebSource,
  type WebSourceType,
} from './types';

import { classifyResearchIntent } from './research-intent';
import { buildResearchPlan, deriveSubQuestions } from './research-planner';
import { UnconfiguredSearchProvider, type SearchProvider } from './search-provider';
import { WebFetchProvider } from './web-fetch';
import { extractWebContent } from './web-extraction';
import { WebContentSafety } from './content-safety';
import {
  assignIndependenceGroups,
  deduplicateSources,
  normalizeSource,
  normalizeUnreadableSource,
} from './source-normalization';
import { scoreSource } from './source-quality';
import { extractEvidence, buildPassages } from './evidence';
import { buildClaimGraph, applyContradictionOutcomes } from './claim-graph';
import { analyseIndependence, corroborate } from './corroboration';
import { detectContradictions } from './contradiction';
import { runFactCheck } from './fact-check';
import { assessConfidence } from './confidence';
import { assembleResearchContext } from './research-context';
import { synthesiseResearch } from './synthesis';
import { buildCitations, verifyCitations } from './citations';
import { runResearchCritic, RESEARCH_AGENT_CONTRACTS } from './agents';
import { findLatestVerified, summariseFreshness } from './freshness';
import { inspectUrl, type UrlGuardOptions } from './url-safety';
import { claimFromQuestion, shortHash, truncateWords } from './text-utils';

export * from './types';
export { classifyResearchIntent } from './research-intent';
export { buildResearchPlan, deriveSubQuestions, subjectOf } from './research-planner';
export { expandQueries } from './query-expansion';
export {
  UnconfiguredSearchProvider,
  FixtureSearchProvider,
  SearxngSearchProvider,
  createSearchProviderFromEnv,
  assertProviderHonest,
  type SearchProvider,
} from './search-provider';
export { WebFetchProvider, parseRobots, isPathAllowed } from './web-fetch';
export { extractWebContent, parseAssertedDate, decodeEntities } from './web-extraction';
export { WebContentSafety, WEB_TRUST_NOTICE } from './content-safety';
export {
  canonicalizeUrl,
  inferSourceType,
  contentHashOf,
  deduplicateSources,
  assignIndependenceGroups,
  independentGroupCount,
  shingles,
  shingleSimilarity,
} from './source-normalization';
export { scoreSource, rankSources, dominantGroupShare, type QualityContext } from './source-quality';
export { assessFreshness, findLatestVerified, summariseFreshness, type FreshnessAssessment, type FreshnessSummary } from './freshness';
export { extractEvidence, extractEvidenceUnits, passagesOf, buildPassages } from './evidence';
export { buildClaimGraph, applyContradictionOutcomes } from './claim-graph';
export { analyseIndependence, corroborate } from './corroboration';
export { detectContradictions } from './contradiction';
export { runFactCheck, type FactCheckInput } from './fact-check';
export { assessConfidence, type ConfidenceInput } from './confidence';
export { assembleResearchContext, type AssembledContext } from './research-context';
export { synthesiseResearch, type SynthesisInput } from './synthesis';
export { buildCitations, verifyCitations } from './citations';
export { runResearchCritic, RESEARCH_AGENT_CONTRACTS, agentCanExecuteTools } from './agents';
export { inspectUrl, assertSafeUrl, sanitizeUrlForDisplay, domainOf } from './url-safety';
export { buildAuditCorpus, StaticFixtureFetchProvider, fixturePage, FIXTURE_URLS } from './fixture-corpus';

export const RESEARCH_ENGINE_VERSION = '1.3.0';
export const RESEARCH_ENGINE_ID = 'deep-research-web-intelligence';

/* ==========================================================================
 * Document evidence (v1.2 bridge)
 * ======================================================================== */

export interface DocumentEvidenceInput {
  documentId: string;
  documentTitle: string;
  passages: Array<{ text: string; page: number | null; section: string | null }>;
  projectId?: string | null;
}

/** Owner-scoped bridge to the v1.2 document engine. */
export type DocumentEvidenceProvider = (
  query: string,
  options: { projectId: string | null; documentIds: string[] }
) => Promise<DocumentEvidenceInput[]>;

export interface ResearchRunRequest extends ResearchRequest {
  documentProvider?: DocumentEvidenceProvider | null;
}

export interface ResearchEngineOptions {
  /**
   * URL policy applied to provider output before any fetch is attempted.
   *
   * In production this stays empty and every loopback/private/metadata target is
   * refused. The audit and the fetch-layer tests set `testOnlyAllowedHosts` for
   * ONE in-process fixture origin; it is never read from environment config.
   */
  urlGuard?: UrlGuardOptions;
  searchProvider?: SearchProvider;
  fetchProvider?: FetchProviderLike;
  documentProvider?: DocumentEvidenceProvider | null;
  now?: () => Date;
  taskIdFactory?: () => string;
  /**
   * Progress sink. Called as (taskId, event) so a sink can route events for
   * concurrent runs without holding engine state.
   */
  onProgress?: (taskId: string, event: ResearchProgressEvent) => void;
}

export interface TaskRecord {
  taskId: string;
  ownerId: string;
  query: string;
  mode: ResearchResult['mode'];
  status: ResearchTaskStatus;
  createdAt: string;
  updatedAt: string;
  cancelled: boolean;
  progress: ResearchProgressEvent[];
  metrics: ResearchMetrics | null;
  result: ResearchResult | null;
}

interface InternalTask extends TaskRecord {
  controller: AbortController;
  startedAt: number;
}

/* ==========================================================================
 * Engine
 * ======================================================================== */

export class ResearchEngine {
  private readonly searchProvider: SearchProvider;
  private readonly fetchProvider: FetchProviderLike;
  private readonly documentProvider: DocumentEvidenceProvider | null;
  private readonly now: () => Date;
  private readonly taskIdFactory: () => string;
  private readonly onProgress?: (taskId: string, event: ResearchProgressEvent) => void;
  private readonly safety = new WebContentSafety();
  private readonly urlGuard: UrlGuardOptions;
  private readonly tasks = new Map<string, InternalTask>();

  constructor(options: ResearchEngineOptions = {}) {
    this.searchProvider = options.searchProvider ?? new UnconfiguredSearchProvider();
    this.fetchProvider = options.fetchProvider ?? new WebFetchProvider();
    this.documentProvider = options.documentProvider ?? null;
    this.now = options.now ?? (() => new Date());
    this.taskIdFactory = options.taskIdFactory ?? (() => `rsch-${shortHash(`${Date.now()}:${Math.random()}`)}`);
    this.onProgress = options.onProgress;
    this.urlGuard = options.urlGuard ?? {};
  }

  /** Honest provider health for the API/UI. */
  providerHealth(): SearchProviderHealth {
    return this.searchProvider.health();
  }

  /** The agent contracts this engine executes, for the capability registry. */
  static agentContracts() {
    return RESEARCH_AGENT_CONTRACTS;
  }

  /* ---------------------------------------------------------------------- */
  /* Task handles                                                           */
  /* ---------------------------------------------------------------------- */

  getTask(taskId: string, ownerId: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) return null;
    return this.toRecord(task);
  }

  listTasks(ownerId: string, limit = 20): TaskRecord[] {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit) || 20));
    return [...this.tasks.values()]
      .filter((task) => task.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded)
      .map((task) => this.toRecord(task));
  }

  cancel(taskId: string, ownerId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) return false;
    if (task.status !== 'RUNNING') return false;
    task.cancelled = true;
    task.controller.abort();
    return true;
  }

  private toRecord(task: InternalTask): TaskRecord {
    return {
      taskId: task.taskId,
      ownerId: task.ownerId,
      query: task.query,
      mode: task.mode,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancelled: task.cancelled,
      progress: [...task.progress],
      metrics: task.metrics,
      result: task.result,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Run                                                                    */
  /* ---------------------------------------------------------------------- */

  async run(request: ResearchRunRequest): Promise<ResearchResult> {
    const ownerId = request.ownerId;
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
      throw new Error('ResearchEngine.run() requires a non-empty ownerId.');
    }

    const query = (request.query ?? '').trim();
    const startedAt = Date.now();
    const createdAt = this.now().toISOString();

    const controller = new AbortController();
    const taskId = this.taskIdFactory();

    const task: InternalTask = {
      taskId,
      ownerId,
      query,
      mode: request.mode ?? 'QUICK_RESEARCH',
      status: 'RUNNING',
      createdAt,
      updatedAt: createdAt,
      cancelled: false,
      progress: [],
      metrics: null,
      result: null,
      controller,
      startedAt,
    };
    this.tasks.set(taskId, task);

    // ---- Cancellation plumbing ----
    const externalSignal = request.signal;
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const cancelled = (): boolean => controller.signal.aborted;

    const progress: ResearchProgressEvent[] = [];
    const emit = (stage: ResearchStage, detail: string, counts?: ResearchProgressEvent['counts']): void => {
      const bounded = truncateWords(detail, 240);
      const event: ResearchProgressEvent = { stage, at: this.now().toISOString(), detail: bounded, counts };
      progress.push(event);
      task.progress = progress;
      task.updatedAt = event.at;
      try {
        this.onProgress?.(taskId, event);
      } catch {
        /* a broken progress sink must never break the run */
      }
    };

    const errors: ResearchFailureCode[] = [];
    let cancelledAtStage: ResearchStage | null = null;

    const finish = (
      status: ResearchTaskStatus,
      payload: Partial<ResearchResult> & { report?: ResearchReport | null }
    ): ResearchResult => {
      const result: ResearchResult = {
        ok: status !== 'FAILED',
        taskId,
        query,
        mode: task.mode,
        status,
        intent: payload.intent ?? classifyResearchIntent(query),
        plan: payload.plan ?? buildResearchPlan(query, classifyResearchIntent(query), { now: this.now(), mode: task.mode }),
        report: payload.report ?? null,
        sources: payload.sources ?? [],
        evidence: payload.evidence ?? [],
        claimGraph: payload.claimGraph ?? { nodes: [], extractedCount: 0, staleSuperseded: 0 },
        errors: payload.errors ?? errors,
        durationMs: Date.now() - startedAt,
        cancelledAtStage,
        metrics: {
          ...(payload.metrics ?? this.emptyMetrics()),
          cancelled: status === 'CANCELLED',
          ...(status === 'CANCELLED' ? { cancelledAtStage } : {}),
        },
      };

      task.status = status;
      task.result = result;
      task.metrics = result.metrics;
      task.updatedAt = this.now().toISOString();
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      return result;
    };

    // ---- 1. Intent + scope ----
    if (!query || query.length < 3) {
      errors.push('INVALID_QUERY');
      const intent = classifyResearchIntent(query || 'empty query');
      const plan = buildResearchPlan(query || 'empty query', intent, { now: this.now(), mode: task.mode });
      emit('Understanding question', 'The question was empty or too short to research.');
      return finish('FAILED', { intent, plan, errors });
    }

    emit('Understanding question', 'Classifying what kind of research this question needs.');
    if (cancelled()) {
      cancelledAtStage = 'Understanding question';
      return finish('CANCELLED', {});
    }

    const intent = classifyResearchIntent(query, { mode: request.mode });
    task.mode = intent.mode;

    const plan = buildResearchPlan(query, intent, {
      now: this.now(),
      mode: intent.mode,
      maxQueries: request.maxQueries,
      maxSources: request.maxSources,
      freshness: request.freshness,
    });

    const deadlineAt = startedAt + plan.budget.deadlineMs;
    const pastDeadline = (): boolean => Date.now() > deadlineAt;

    if (cancelled()) {
      cancelledAtStage = 'Planning research';
      return finish('CANCELLED', { intent, plan });
    }

    emit('Planning research', `Planned ${plan.objective.subQuestions.length} sub-question(s) and ${plan.objective.searchQueries.length} quer${plan.objective.searchQueries.length === 1 ? 'y' : 'ies'}.`, {
      queries: plan.objective.searchQueries.length,
    });

    const providerHealth = this.searchProvider.health();
    const metrics: ResearchMetrics = {
      ...this.emptyMetrics(),
      searchProvider: providerHealth.providerId,
      searchProviderStatus: providerHealth.status,
      live: providerHealth.live,
    };

    // ---- 2. Discovery ----
    const candidateMap = new Map<string, { url: string; title: string; snippet: string; publishedAt: string | null }>();

    if (providerHealth.status === 'UNCONFIGURED' || providerHealth.status === 'UNAVAILABLE') {
      errors.push('SEARCH_UNAVAILABLE');
      emit('Searching sources', 'No live search provider is configured, so no query was sent anywhere.');
    } else {
      emit('Searching sources', `Running ${plan.objective.searchQueries.length} planned quer${plan.objective.searchQueries.length === 1 ? 'y' : 'ies'}.`);

      for (const searchQuery of plan.objective.searchQueries) {
        if (cancelled() || pastDeadline()) break;

        const response = await this.searchProvider.search({
          query: searchQuery,
          limit: 8,
          signal: controller.signal,
          scholarlyOnly: intent.kind === 'academic_discovery',
        });

        metrics.queryCount += 1;

        if (!response.ok) {
          if (response.errorCode && !errors.includes(response.errorCode)) errors.push(response.errorCode);
          continue;
        }

        // A provider claiming to be live when it is not is a hard error.
        if (response.live !== providerHealth.live) {
          errors.push('SEARCH_UNAVAILABLE');
          break;
        }

        for (const result of response.results) {
          const verdict = inspectUrl(result.url, this.urlGuard);
          if (!verdict.safe) continue; // provider output is untrusted
          if (candidateMap.has(result.url)) continue;
          candidateMap.set(result.url, {
            url: result.url,
            title: result.title,
            snippet: result.snippet,
            publishedAt: result.publishedAt,
          });
          if (candidateMap.size >= plan.budget.maxSources * 2) break;
        }
      }
    }

    const candidates = [...candidateMap.values()].slice(0, Math.max(plan.budget.maxFetches, plan.maxSources));
    metrics.sourcesDiscovered = candidates.length;

    if (cancelled()) {
      cancelledAtStage = 'Searching sources';
      return finish('CANCELLED', { intent, plan, metrics });
    }

    // ---- 3. Document evidence (v1.2 bridge) ----
    const documentSources = await this.collectDocumentSources(request, query, controller.signal);
    for (const source of documentSources) candidateMap.set(source.url, {
      url: source.url,
      title: source.title,
      snippet: '',
      publishedAt: source.publishedAt,
    });

    // ---- 4. Fetch + safety + extraction + normalization ----
    const fetched: WebSource[] = [...documentSources];
    const discoverySources = candidates.filter(
      (candidate) => !documentSources.some((document) => document.url === candidate.url)
    );

    if (discoverySources.length > 0) {
      emit('Reading evidence', `Fetching ${Math.min(discoverySources.length, plan.budget.maxFetches)} candidate source(s).`);
    }

    let fetchCount = 0;
    for (const candidate of discoverySources) {
      if (cancelled() || pastDeadline()) break;
      if (fetchCount >= plan.budget.maxFetches) break;
      fetchCount += 1;

      let page: FetchedPage;
      try {
        page = await this.fetchProvider.fetch({ url: candidate.url, signal: controller.signal });
      } catch (error) {
        page = {
          status: 'FETCH_FAILED',
          finalUrl: null,
          requestedUrl: candidate.url,
          httpStatus: null,
          contentType: null,
          bytes: 0,
          body: null,
          redirectChain: [],
          detail: error instanceof Error ? error.message.slice(0, 120) : 'fetch threw',
          durationMs: 0,
        };
      }

      if (page.status !== 'OK' || !page.body) {
        // The failure is RECORDED but the page is not admitted as a source: a
        // page that could not be read must never look like a readable source.
        metrics.fetchFailures.push({ domain: candidate.url, status: page.status });
        metrics.unreadableSources.push({ url: candidate.url, status: page.status });
        continue;
      }

      // ---- Safety first: neutralise directives before extraction is trusted ----
      const retrievedAt = this.now().toISOString();
      const extracted = extractWebContent(page.body, { contentType: page.contentType, baseUrl: page.finalUrl ?? candidate.url });
      const safety = this.safety.scan(extracted.mainText);

      const source = normalizeSource({
        page,
        extracted: { ...extracted, mainText: safety.neutralizedText },
        safeText: safety.neutralizedText,
        injectionFlagged: safety.flagged,
        retrievedAt,
        searchSnippet: candidate.snippet,
      });

      fetched.push(source);
      metrics.sourcesFetched += 1;
    }

    if (cancelled()) {
      cancelledAtStage = 'Reading evidence';
      return finish('CANCELLED', { intent, plan, sources: fetched, metrics });
    }

    // ---- 5. Normalize, deduplicate, score ----
    emit('Evaluating sources', 'Collapsing duplicates and scoring each source against the question.');
    const deduped = deduplicateSources(fetched);
    assignIndependenceGroups(deduped);

    const independence = analyseIndependence(deduped);
    const queryTerms = plan.objective.mainQuestion
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3);

    for (const source of deduped) {
      if (source.fetchStatus !== 'OK') continue;
      source.quality = scoreSource(source, {
        intent,
        queryTerms,
        now: this.now(),
        freshnessRequirement: plan.objective.freshnessRequirement,
        freshnessWeight: plan.budget.freshnessWeight,
        corroborationGroups: independence.independentGroupCount,
      }).quality;
    }

    // ---- 6. Evidence ----
    emit('Reading evidence', 'Extracting bounded evidence passages.');
    let extraction = extractEvidence(deduped, {
      query,
      intent,
      maxUnits: plan.budget.maxEvidenceUnits,
      now: this.now(),
    });
    let evidence = extraction.units;
    metrics.evidenceUnits = evidence.length;

    // ---- 7. Claims ----
    let graph = buildClaimGraph({
      query,
      subQuestions: plan.objective.subQuestions,
      evidence,
      sources: deduped,
      context: {
        now: this.now(),
        freshnessRequirement: plan.objective.freshnessRequirement,
        minIndependentSupport: plan.budget.minIndependentSources,
      },
    });

    // ---- 8. Contradictions ----
    emit('Checking contradictions', 'Comparing credible sources for disagreement.');
    let contradictions = detectContradictions(evidence, deduped, { now: this.now() });
    graph = applyContradictionOutcomes(graph, contradictions);
    metrics.contradictions = contradictions.length;

    // ---- 9. Targeted follow-up (bounded) ----
    let followUpRounds = 0;
    while (followUpRounds < plan.budget.maxFollowUpRounds && !cancelled() && !pastDeadline()) {
      const gaps = findGapQuestions(plan, evidence);
      if (gaps.length === 0) break;

      emit('Following up', `Targeted follow-up for ${gaps.length} uncovered sub-question(s).`, { sources: deduped.length });

      const followUpQueries = gaps
        .map((gap) => subjectForFollowUp(gap))
        .filter((text) => text.length > 0)
        .slice(0, 2);

      if (followUpQueries.length === 0) break;

      const extraCandidates: Array<{ url: string; title: string; snippet: string; publishedAt: string | null }> = [];
      for (const followUpQuery of followUpQueries) {
        if (cancelled() || pastDeadline()) break;
        const response = await this.searchProvider.search({ query: followUpQuery, limit: 5, signal: controller.signal });
        metrics.queryCount += 1;
        if (!response.ok) continue;
        for (const result of response.results) {
          if (inspectUrl(result.url, this.urlGuard).safe) extraCandidates.push(result);
        }
      }

      const unseen = extraCandidates.filter(
        (candidate) => !deduped.some((source) => source.url === candidate.url || source.canonicalUrl === candidate.url)
      );
      if (unseen.length === 0) break;

      followUpRounds += 1;
      metrics.followUpRounds = followUpRounds;

      for (const candidate of unseen.slice(0, 2)) {
        if (cancelled() || pastDeadline()) break;
        const page = await this.fetchProvider.fetch({ url: candidate.url, signal: controller.signal });
        if (page.status !== 'OK' || !page.body) continue;

        const extracted = extractWebContent(page.body, { contentType: page.contentType, baseUrl: page.finalUrl ?? candidate.url });
        const safety = this.safety.scan(extracted.mainText);
        const source = normalizeSource({
          page,
          extracted: { ...extracted, mainText: safety.neutralizedText },
          safeText: safety.neutralizedText,
          injectionFlagged: safety.flagged,
          retrievedAt: this.now().toISOString(),
          searchSnippet: candidate.snippet,
        });

        deduped.push(source);
        metrics.sourcesFetched += 1;
      }

      assignIndependenceGroups(deduped);
      extraction = extractEvidence(deduped, { query, intent, maxUnits: plan.budget.maxEvidenceUnits, now: this.now() });
      evidence = extraction.units;
      metrics.evidenceUnits = evidence.length;

      graph = buildClaimGraph({
        query,
        subQuestions: plan.objective.subQuestions,
        evidence,
        sources: deduped,
        context: {
          now: this.now(),
          freshnessRequirement: plan.objective.freshnessRequirement,
          minIndependentSupport: plan.budget.minIndependentSources,
        },
      });
      contradictions = detectContradictions(evidence, deduped, { now: this.now() });
      graph = applyContradictionOutcomes(graph, contradictions);
      metrics.contradictions = contradictions.length;
    }

    if (cancelled()) {
      cancelledAtStage = 'Following up';
      return finish('CANCELLED', { intent, plan, sources: deduped, evidence, claimGraph: graph, metrics });
    }

    // The progress stream always announces the follow-up stage, even when the
    // answer is "no follow-up was required".
    if (followUpRounds === 0) {
      emit('Following up', 'No follow-up round was required.');
    }

    // ---- 10. Verification, synthesis, citations ----
    emit('Verifying claims', 'Assessing claim support and independence.');
    const coverage = computeCoverage(plan, evidence);
    const freshness = summariseFreshness(deduped, {
      now: this.now(),
      requirement: plan.objective.freshnessRequirement,
      newestComparableAgeDays: null,
    });

    const factCheck: FactCheckResult | null =
      task.mode === 'FACT_CHECK'
        ? runFactCheck({
            claim: query,
            nodes: graph.nodes,
            subQuestions: plan.objective.subQuestions,
            sources: deduped,
            freshnessRequirement: plan.objective.freshnessRequirement,
            freshnessNote: freshness.note,
          })
        : null;

    if (task.mode === 'LATEST') {
      // "Latest" is only stated when a dated record actually exists.
      const latest = findLatestVerified(deduped, this.now());
      if (!latest) {
        graph = {
          ...graph,
          nodes: graph.nodes.map((node) =>
            node.state === 'SUPPORTED'
              ? { ...node, state: 'PARTIALLY_SUPPORTED' as const, notes: [...node.notes, 'No verifiable publication date; "latest" cannot be asserted.'] }
              : node
          ),
        };
      }
    }

    const confidence = assessConfidence({
      nodes: graph.nodes,
      sources: deduped,
      contradictions,
      coverage,
      freshness,
      citationsVerified: true, // provisional; re-assessed after verification
    });

    // Citations are built BEFORE synthesis: every finding must be born with a
    // resolvable citation, never retro-fitted with one afterwards.
    const citations = buildCitations({ sources: deduped, evidence });

    emit('Checking citations', 'Hashing sources and verifying every citation.');

    // Bounded context assembly: enforce the token ceiling before synthesis and
    // surface it, rather than silently truncating downstream.
    const assembled = assembleResearchContext({
      question: query,
      evidence,
      sources: deduped,
      citations,
      maxTokens: plan.budget.maxContextTokens,
      maxSources: 10,
    });

    const synthesis = synthesiseResearch({
      query,
      mode: task.mode,
      nodes: graph.nodes,
      evidence,
      sources: deduped,
      citations,
      contradictions,
      confidence,
      factCheck,
      freshness,
      limitations: [],
      live: providerHealth.live,
    });

    const findings = [...synthesis.verifiedFindings, ...synthesis.qualifiedFindings, ...synthesis.conflicts];

    const verification = verifyCitations({
      findings,
      citations,
      evidence,
      sources: deduped,
      now: this.now(),
      freshnessRequirement: plan.objective.freshnessRequirement,
    });

    const verifiedIds = new Set(verification.findings.map((finding) => finding.claimId));

    const verifiedFindings = synthesis.verifiedFindings.filter((finding) => verifiedIds.has(finding.claimId));
    const qualifiedFindings = synthesis.qualifiedFindings.filter((finding) => verifiedIds.has(finding.claimId));
    const conflicts = synthesis.conflicts.filter((finding) => verifiedIds.has(finding.claimId));

    if (verification.verification.issues.length > 0) {
      errors.push('CITATION_VERIFICATION_FAILED');
    }

    const finalConfidence = assessConfidence({
      nodes: graph.nodes.filter((node) => verifiedIds.has(node.claimId) || verifiedIds.size === 0),
      sources: deduped,
      contradictions,
      coverage,
      freshness,
      citationsVerified: verification.verification.ok,
    });

    // ---- 11. Critic ----
    const critic = runResearchCritic({
      mode: task.mode,
      query,
      sources: deduped,
      nodes: graph.nodes,
      contradictions,
      citations: verification.citations,
      citationVerification: verification.verification,
      confidence: finalConfidence,
      freshness,
      factCheck,
      coverage,
      live: providerHealth.live,
    });

    // ---- 12. Status ----
    const readableSources = deduped.filter((source) => source.fetchStatus === 'OK');
    const status: ResearchTaskStatus =
      readableSources.length === 0 || evidence.length === 0
        ? 'INSUFFICIENT_EVIDENCE'
        : conflicts.length > 0 || !verification.verification.ok || !critic.passed
          ? 'PARTIAL'
          : 'COMPLETED';

    const limitations = this.buildLimitations({
      providerHealth,
      metrics: { ...metrics, citationCount: verification.citations.length },
      deduped,
      verificationIssues: verification.verification.issues.length,
      removedClaims: verification.verification.removedClaims.length,
      critic,
    });

    const report: ResearchReport = {
      title: truncateWords(query, 160),
      query,
      mode: task.mode,
      generatedAt: this.now().toISOString(),
      live: providerHealth.live,
      status,
      executiveSummary: synthesis.executiveSummary,
      verifiedFindings,
      qualifiedFindings,
      conflicts,
      unknowns: synthesis.unknowns,
      citations: verification.citations,
      confidence: finalConfidence,
      factCheck,
      contradictions,
      sourcesUsed: readableSources.length,
      sourcesDiscovered: candidates.length + documentSources.length,
      providerStatus: providerHealth,
      limitations,
      progress,
    };

    metrics.citationCount = verification.citations.length;
    metrics.contextTokens = assembled.tokenEstimate;
    metrics.contextTruncated = assembled.truncated;
    metrics.confidence = finalConfidence.level;
    metrics.verificationStatus = verification.verification.ok ? 'VERIFIED' : 'REPAIRED';

    if (!critic.passed) {
      errors.push('CITATION_VERIFICATION_FAILED');
    }

    emit('Research complete', `Research finished with ${readableSources.length} readable source(s).`, {
      sources: readableSources.length,
      evidence: evidence.length,
      contradictions: contradictions.length,
    });

    return finish(status, {
      intent,
      plan,
      report,
      sources: deduped,
      evidence,
      claimGraph: graph,
      metrics,
      errors: [...new Set(errors)],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private emptyMetrics(): ResearchMetrics {
    return {
      queryCount: 0,
      searchProvider: 'unconfigured',
      searchProviderStatus: 'UNCONFIGURED',
      live: false,
      sourcesDiscovered: 0,
      sourcesFetched: 0,
      fetchFailures: [],
      unreadableSources: [],
      evidenceUnits: 0,
      followUpRounds: 0,
      contradictions: 0,
      citationCount: 0,
      contextTokens: 0,
      contextTruncated: false,
      confidence: 'INSUFFICIENT',
      verificationStatus: 'UNVERIFIED',
      cancelled: false,
    };
  }

  /** v1.2 document bridge — owner-scoped, provenance kept separate. */
  private async collectDocumentSources(
    request: ResearchRunRequest,
    query: string,
    signal: AbortSignal
  ): Promise<WebSource[]> {
    const provider = request.documentProvider ?? this.documentProvider;
    if (!provider) return [];
    // Documents are only read when the caller explicitly selected them.
    const documentIds = (request.documentIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    if (documentIds.length === 0) return [];
    if (signal.aborted) return [];

    try {
      const documents = await provider(query, { projectId: request.projectId ?? null, documentIds });
      const sources: WebSource[] = [];

      for (const document of documents) {
        const text = document.passages
          .map((passage) => `${passage.section ? `## ${passage.section}\n` : ''}${passage.text}`)
          .join('\n\n')
          .trim();
        if (text.length < 40) continue;

        const safety = this.safety.scan(text);
        const sourceType: WebSourceType = 'OWNER_DOCUMENT';

        sources.push({
          sourceId: `src-doc-${shortHash(document.documentId)}`,
          url: `document://${document.documentId}`,
          canonicalUrl: `document://${document.documentId}`,
          domain: 'owner-document',
          title: document.documentTitle,
          author: null,
          publishedAt: null,
          updatedAt: null,
          retrievedAt: this.now().toISOString(),
          contentHash: `doc-${shortHash(text)}`,
          sourceType,
          trustSignals: ['owner_document', ...(safety.flagged ? ['prompt_injection_neutralised'] : [])],
          freshnessSignals: ['document_date_unknown'],
          extractedText: safety.neutralizedText,
          provenance: 'DOCUMENT_SOURCE',
          fetchStatus: 'OK',
          academic: null,
          duplicateOf: null,
          independenceGroup: 'owner-document',
          quality: null,
        });
      }

      return sources;
    } catch {
      return [];
    }
  }

  private buildLimitations(input: {
    providerHealth: SearchProviderHealth;
    metrics: ResearchMetrics;
    deduped: WebSource[];
    verificationIssues: number;
    removedClaims: number;
    critic: { issues: Array<{ code: string; message: string }> };
  }): string[] {
    const limitations: string[] = [];

    if (!input.providerHealth.live) {
      limitations.push(
        input.providerHealth.status === 'UNCONFIGURED'
          ? 'No live search provider is configured. LIVE web research is UNCONFIGURED and no source was invented to fill the gap.'
          : `The search provider "${input.providerHealth.providerId}" is NOT live. Results come from a synthetic index and must not be presented as real web research.`
      );
    }

    // Unreadable sources are excluded from `sources`, so the limitation is read
    // from the metrics record of failures.
    const unreadable = input.metrics.unreadableSources;
    if (unreadable.length > 0) {
      const statuses = [...new Set(unreadable.map((entry) => entry.status))];
      limitations.push(
        `Access failure on ${unreadable.length} source(s) (${statuses.join(', ')}). They were not used as evidence and their controls were not bypassed.`
      );
    }

    // Older, still-relevant wording for direct fetch failures that were never
    // promoted to a source record.
    const failedStatuses = [...new Set(input.metrics.fetchFailures.map((failure) => failure.status))];
    if (unreadable.length === 0 && failedStatuses.length > 0) {
      limitations.push(
        `Access failure on ${input.metrics.fetchFailures.length} request(s) (${failedStatuses.join(', ')}); they were not used as evidence.`
      );
    }

    const duplicated = input.deduped.filter((source) => source.duplicateOf);
    if (duplicated.length > 0) {
      limitations.push(
        `${duplicated.length} duplicate or syndicated source(s) were collapsed and were not counted as independent corroboration.`
      );
    }

    if (input.verificationIssues > 0) {
      limitations.push(
        `${input.verificationIssues} citation issue(s) were detected and repaired before publication${input.removedClaims > 0 ? `; ${input.removedClaims} finding(s) were removed` : ''}.`
      );
    }

    for (const issue of input.critic.issues.slice(0, 5)) {
      limitations.push(issue.message);
    }

    return limitations;
  }
}

/* ==========================================================================
 * Module-level helpers
 * ======================================================================== */

function computeCoverage(plan: ResearchPlan, evidence: EvidenceUnit[]): number {
  const questions = [plan.objective.mainQuestion, ...plan.objective.subQuestions];
  if (questions.length === 0) return 0;

  let covered = 0;
  for (const question of questions) {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
    if (terms.length === 0) continue;

    const required = Math.max(1, Math.ceil(terms.length * 0.35));
    const hit = evidence.some((unit) => {
      const passage = unit.passage.toLowerCase();
      return terms.filter((term) => passage.includes(term)).length >= required;
    });
    if (hit) covered += 1;
  }

  return covered / questions.length;
}

function findGapQuestions(plan: ResearchPlan, evidence: EvidenceUnit[]): string[] {
  return plan.objective.subQuestions.filter((question) => {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4);
    if (terms.length === 0) return false;
    const required = Math.max(1, Math.ceil(terms.length * 0.35));
    return !evidence.some((unit) => {
      const passage = unit.passage.toLowerCase();
      return terms.filter((term) => passage.includes(term)).length >= required;
    });
  });
}

function subjectForFollowUp(question: string): string {
  return claimFromQuestion(question);
}

/** A ready-made engine for environments with no configured provider. */
export function createUnconfiguredResearchEngine(options: ResearchEngineOptions = {}): ResearchEngine {
  return new ResearchEngine({
    searchProvider: new UnconfiguredSearchProvider(),
    ...options,
  });
}

/** A deterministic engine over the non-live fixture corpus (tests/audits). */
export function createFixtureResearchEngine(options: ResearchEngineOptions = {}): ResearchEngine {
  // Imported here so production bundles never pull the fixture corpus eagerly.
  const { createFixtureStack } = require('./fixture-corpus') as typeof import('./fixture-corpus');
  const stack = createFixtureStack();

  return new ResearchEngine({
    searchProvider: stack.searchProvider,
    fetchProvider: stack.fetchProvider,
    ...options,
  });
}

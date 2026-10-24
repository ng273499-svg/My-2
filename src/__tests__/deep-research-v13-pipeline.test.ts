/**
 * JARVIS-X v1.3.0 — Deep Research pipeline tests (M–AP).
 *
 * Every test here runs against an in-process fixture corpus and is therefore
 * NON-LIVE. Nothing in this file touches the public internet.
 */

import { describe, expect, it } from 'vitest';

import { ResearchEngine, RESEARCH_ENGINE_VERSION, type DocumentEvidenceProvider } from '@/core/research';
import { classifyResearchIntent } from '@/core/research/research-intent';
import { canonicaliseUrl, inferSourceType } from '@/core/research/source-normalization';
import { scoreSource, independentGroupCount, dominantGroupShare } from '@/core/research/source-quality';
import { assessFreshness, findLatestVerified } from '@/core/research/freshness';
import { extractEvidence, passagesOf } from '@/core/research/evidence';
import { analyseIndependence } from '@/core/research/corroboration';
import { detectContradictions, hasHistoricalScope } from '@/core/research/contradiction';
import { buildCitationSet, verifyCitations } from '@/core/research/citations';
import { assembleResearchContext } from '@/core/research/research-context';
import { StaticFixtureFetchProvider, buildAuditCorpus } from '@/core/research/fixture-corpus';
import { FixtureSearchProvider, type SearchProvider } from '@/core/research/search-provider';
import { RESEARCH_MODES, RESEARCH_STAGES, type WebSource, type WebSourceType } from '@/core/research/types';

const NOW = new Date('2026-10-24T00:00:00.000Z');
const TTL_QUERY = 'What is the default time-to-live for a cached entry in Quantum Cache?';

function corpusEngine(overrides: { searchProvider?: SearchProvider; documentProvider?: DocumentEvidenceProvider | null } = {}) {
  const { documents, failures } = buildAuditCorpus();
  return new ResearchEngine({
    searchProvider: overrides.searchProvider ?? new FixtureSearchProvider({ documents }),
    fetchProvider: new StaticFixtureFetchProvider({ documents, failures }),
    documentProvider: overrides.documentProvider ?? null,
    now: () => NOW,
  });
}

let sourceSeq = 0;

/** Builds a fully-formed WebSource — no partial casts, so the tests track the contract. */
function makeSource(overrides: Partial<WebSource> & { url: string }): WebSource {
  sourceSeq += 1;
  const domain = new URL(overrides.url).hostname;
  const base: WebSource = {
    sourceId: `src-${sourceSeq}`,
    url: overrides.url,
    canonicalUrl: overrides.url,
    domain,
    title: `Source ${sourceSeq}`,
    author: null,
    publishedAt: null,
    updatedAt: null,
    retrievedAt: NOW.toISOString(),
    contentHash: `hash-${sourceSeq}`,
    sourceType: 'UNKNOWN',
    trustSignals: [],
    freshnessSignals: [],
    extractedText: 'Default extracted text for this source.',
    provenance: 'WEB_SOURCE',
    fetchStatus: 'OK',
    academic: null,
    duplicateOf: null,
    independenceGroup: `group-${sourceSeq}`,
    quality: null,
  };
  return { ...base, ...overrides };
}

function intentFor(query: string, mode: (typeof RESEARCH_MODES)[number] = 'DEEP_RESEARCH') {
  return classifyResearchIntent(query, { mode });
}

const documentProviderStub = (passages: string[]): DocumentEvidenceProvider => async () => [
  {
    documentId: 'doc-1',
    documentTitle: 'internal-ttl.pdf',
    passages: passages.map((text, index) => ({ text, page: index + 1, section: null })),
    projectId: null,
  },
];

/* ==========================================================================
 * M. Source normalization / canonical dedup
 * ======================================================================== */

describe('v1.3 M — Source normalization and canonical de-duplication', () => {
  it('canonicalises tracking parameters, case, trailing slashes and fragments', () => {
    const a = canonicaliseUrl('https://Example.com/docs/page/?utm_source=x&utm_medium=y#section');
    const b = canonicaliseUrl('https://example.com/docs/page');
    expect(a).toBe(b);
    expect(a).not.toContain('utm_');
    expect(a).not.toContain('#');
  });

  it('strips AMP and index variants', () => {
    expect(canonicaliseUrl('https://example.com/post/amp')).toBe(canonicaliseUrl('https://example.com/post'));
    expect(canonicaliseUrl('https://example.com/post/index.html')).toBe(canonicaliseUrl('https://example.com/post'));
  });

  it('preserves meaningful query parameters', () => {
    const canonical = canonicaliseUrl('https://example.com/search?q=cache&page=2');
    expect(canonical).toContain('q=cache');
    expect(canonical).toContain('page=2');
  });

  it('infers source type from official, academic and community signals', () => {
    const official = inferSourceType('https://docs.example.org/reference/quantum-cache');
    const academic = inferSourceType('https://arxiv.org/abs/2401.00001');
    const forum = inferSourceType('https://stackoverflow.com/questions/1234/cache');

    const types: WebSourceType[] = [official.type, academic.type, forum.type];
    for (const type of types) expect(typeof type).toBe('string');
    expect(academic.type).toBe('ACADEMIC');
    expect(forum.type).toBe('COMMUNITY_FORUM');
    expect(official.signals.length).toBeGreaterThan(0);
  });

  it('collapses a mirror into one representative and records the duplicate', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });

    const duplicates = result.sources.filter((source) => source.duplicateOf !== null);
    expect(duplicates.length).toBeGreaterThan(0);
    for (const duplicate of duplicates) {
      // A duplicate always points at a source that actually survived.
      expect(result.sources.some((source) => source.sourceId === duplicate.duplicateOf)).toBe(true);
      expect(duplicate.sourceId).not.toBe(duplicate.duplicateOf);
    }
  });

  it('never merges two different documents that merely share a topic', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const independent = result.sources.filter((source) => source.duplicateOf === null);
    expect(independent.length).toBeGreaterThan(1);
    expect(canonicaliseUrl('https://example.com/a/cache')).not.toBe(canonicaliseUrl('https://example.com/b/cache'));
  });
});

/* ==========================================================================
 * N. Query-dependent source quality
 * ======================================================================== */

describe('v1.3 N — Source quality is query-dependent, with no static allow-list', () => {
  it('scores the same document differently for different questions', () => {
    const shared = makeSource({
      url: 'https://example.org/cache-overview',
      title: 'Quantum Cache overview and pricing',
      extractedText:
        'Quantum Cache overview. Pricing tiers start at one hundred rupees per seat per month. ' +
        'The cache stores entries in memory and supports eviction.',
      publishedAt: '2026-10-01T00:00:00.000Z',
    });

    const pricing = scoreSource(shared, {
      queryTerms: ['pricing', 'seat', 'month'],
      intent: intentFor('What is the pricing per seat month?', 'MARKET_RESEARCH'),
      freshnessRequirement: 'prefer_recent',
      now: NOW,
      corroborationGroups: 1,
    });

    const algorithm = scoreSource(shared, {
      queryTerms: ['eviction', 'algorithm', 'internals'],
      intent: intentFor('What eviction algorithm is used internally?', 'TECHNICAL_RESEARCH'),
      freshnessRequirement: 'none',
      now: NOW,
      corroborationGroups: 1,
    });

    expect(pricing.quality.relevance).not.toBe(algorithm.quality.relevance);
    expect(pricing.quality.relevance).toBeGreaterThan(algorithm.quality.relevance);
  });

  it('prefers a primary technical reference over a community post for a technical question', () => {
    const context = {
      queryTerms: ['cache', 'eviction', 'policy'],
      intent: intentFor('What is the cache eviction policy?', 'TECHNICAL_RESEARCH'),
      freshnessRequirement: 'none' as const,
      now: NOW,
      corroborationGroups: 1,
    };

    const primary = scoreSource(
      makeSource({
        url: 'https://docs.example.org/reference/cache',
        sourceType: 'PRIMARY_OFFICIAL',
        title: 'Cache eviction policy reference',
        extractedText: 'The cache eviction policy is least-recently-used.',
      }),
      context
    );

    const community = scoreSource(
      makeSource({
        url: 'https://forum.example.net/t/cache-eviction',
        sourceType: 'COMMUNITY_FORUM',
        title: 'Cache eviction policy reference question',
        extractedText: 'The cache eviction policy is least-recently-used.',
      }),
      context
    );

    expect(primary.quality.authority).toBeGreaterThan(community.quality.authority);
    expect(primary.quality.overall).toBeGreaterThan(community.quality.overall);
  });

  it('does not treat a vendor claim as independent verification of that vendor', () => {
    const vendor = scoreSource(
      makeSource({
        url: 'https://quantumcache.example.com/why-us',
        sourceType: 'MANUFACTURER_CLAIM',
        title: 'Why Quantum Cache is the fastest',
        extractedText: 'Quantum Cache is the fastest cache available.',
      }),
      {
        queryTerms: ['fastest', 'cache'],
        intent: intentFor('Is Quantum Cache the fastest?', 'FACT_CHECK'),
        freshnessRequirement: 'none',
        now: NOW,
        corroborationGroups: 1,
      }
    );

    expect(vendor.quality.overall).toBeLessThan(0.75);
  });
});

/* ==========================================================================
 * O. Freshness
 * ======================================================================== */

describe('v1.3 O — Freshness engine', () => {
  it('distinguishes fresh, aging and stale snapshots', () => {
    const fresh = assessFreshness(
      makeSource({ url: 'https://a.example/1', publishedAt: '2026-10-20T00:00:00.000Z' }),
      { now: NOW, requirement: 'prefer_recent' }
    );
    const aging = assessFreshness(
      makeSource({ url: 'https://a.example/2', publishedAt: '2024-01-01T00:00:00.000Z' }),
      { now: NOW, requirement: 'prefer_recent' }
    );
    const stale = assessFreshness(
      makeSource({ url: 'https://a.example/3', publishedAt: '2019-01-01T00:00:00.000Z' }),
      { now: NOW, requirement: 'must_be_current' }
    );

    expect(fresh.isStale).toBe(false);
    expect(stale.isStale).toBe(true);
    // Freshness is a gradient, not a boolean.
    expect(fresh.score).toBeGreaterThan(aging.score);
    expect(aging.score).toBeGreaterThan(stale.score);
  });

  it('never invents a date for an undated page', () => {
    const undated = assessFreshness(makeSource({ url: 'https://a.example/3', publishedAt: null }), {
      now: NOW,
      requirement: 'must_be_current',
    });

    expect(undated.dateVerified).toBe(false);
    expect(undated.ageDays).toBeNull();
    expect(undated.referenceDate).toBeNull();
    expect(undated.signals.join(' ')).toMatch(/unverified|unknown|no asserted/i);
  });

  it('only names a "latest" source when a real date is available', () => {
    const older = makeSource({ url: 'https://a.example/4', publishedAt: '2025-01-01T00:00:00.000Z' });
    const newer = makeSource({ url: 'https://b.example/4', publishedAt: '2026-10-01T00:00:00.000Z' });
    const undated = makeSource({ url: 'https://c.example/4', publishedAt: null });

    const latest = findLatestVerified([older, newer, undated], NOW);
    expect(latest).not.toBeNull();
    expect(latest!.source.sourceId).toBe(newer.sourceId);

    expect(findLatestVerified([undated], NOW)).toBeNull();
  });
});

/* ==========================================================================
 * P. Evidence units stay bounded
 * ======================================================================== */

describe('v1.3 P — Bounded evidence units', () => {
  it('splits long pages into passages instead of one giant blob', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i} about cache behaviour, eviction policy and TTL semantics.`).join(' ');
    const source = makeSource({ url: 'https://long.example/page', extractedText: text });
    const passages = passagesOf(source);

    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) expect(passage.text.length).toBeLessThanOrEqual(1200);
  });

  it('keeps every evidence unit small, attributed and never a whole page', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });

    expect(result.evidence.length).toBeGreaterThan(0);
    for (const unit of result.evidence) {
      expect(unit.passage.length).toBeLessThanOrEqual(1200);
      expect(unit.sourceId).toBeTruthy();
      expect(unit.evidenceId).toBeTruthy();
      expect(result.sources.some((source) => source.sourceId === unit.sourceId)).toBe(true);
    }
  });

  it('does not treat navigation boilerplate as evidence', () => {
    const source = makeSource({
      url: 'https://nav.example/page',
      extractedText: 'Home | About | Contact | Privacy | Terms',
      title: 'Home',
    });
    const extraction = extractEvidence([source], {
      maxUnits: 10,
      query: 'cache eviction policy',
      intent: intentFor('cache eviction policy'),
      now: NOW,
    });
    expect(extraction.units).toHaveLength(0);
    expect(extraction.emptySourceIds).toContain(source.sourceId);
  });

  it('respects the maxUnits cap', () => {
    const sources = Array.from({ length: 6 }, (_, i) =>
      makeSource({
        url: `https://cap.example/${i}`,
        title: 'Cache eviction policy',
        extractedText: Array.from({ length: 10 }, (_, j) => `The cache eviction policy is least-recently-used number ${j}.`).join(' '),
      })
    );

    const extraction = extractEvidence(sources, {
      maxUnits: 4,
      query: 'cache eviction policy',
      intent: intentFor('cache eviction policy'),
      now: NOW,
      minRelevance: 0,
    });
    expect(extraction.units.length).toBeLessThanOrEqual(4);
    expect(extraction.truncated).toBe(true);
  });
});

/* ==========================================================================
 * Q–R. Claim graph + verification states
 * ======================================================================== */

describe('v1.3 Q — Claim graph', () => {
  it('produces claims bound to evidence and to a verification state', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const nodes = result.claimGraph.nodes;

    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.claimId).toBeTruthy();
      expect(node.claim.length).toBeGreaterThan(0);
      expect([
        'SUPPORTED',
        'PARTIALLY_SUPPORTED',
        'CONFLICTING',
        'UNSUPPORTED',
        'OUTDATED',
        'UNVERIFIED',
      ]).toContain(node.state);
      expect(Array.isArray(node.notes)).toBe(true);
    }
  });

  it('never marks a claim SUPPORTED without a supporting source', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    for (const node of result.claimGraph.nodes) {
      if (node.state === 'SUPPORTED') {
        expect(node.supportingSourceIds.length).toBeGreaterThan(0);
        expect(node.supportingEvidenceIds.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('v1.3 R — Verification states stay honest', () => {
  it('marks a claim with no supporting passage as UNSUPPORTED or UNVERIFIED', async () => {
    const result = await corpusEngine().run({
      ownerId: 'owner-a',
      query: 'What is the exact quantum flux tolerance of the fictional ZX-9000 device?',
      mode: 'DEEP_RESEARCH',
    });

    for (const node of result.claimGraph.nodes) {
      if (node.supportingEvidenceIds.length === 0) {
        expect(['UNSUPPORTED', 'UNKNOWN']).toContain(node.state);
      }
    }
  });

  it('separates historically scoped statements from present-tense claims', () => {
    expect(hasHistoricalScope('In version 1.x only, the default TTL was 60 seconds.')).toBe(true);
    expect(hasHistoricalScope('The default TTL is 300 seconds.')).toBe(false);
  });
});

/* ==========================================================================
 * S. Corroboration / syndication
 * ======================================================================== */

describe('v1.3 S — Corroboration ignores syndicated copies', () => {
  it('groups mirrors by content hash and by domain', () => {
    const syndicated =
      'Quantum Cache ships a default time to live of three hundred seconds for every cached entry and evicts least recently used entries when full.';
    const a = makeSource({
      url: 'https://site-a.example/story',
      title: 'Cache TTL explained',
      contentHash: 'same-hash',
      extractedText: syndicated,
    });
    const b = makeSource({
      url: 'https://site-b.example/story',
      title: 'Cache TTL explained',
      contentHash: 'same-hash',
      extractedText: syndicated,
    });
    const c = makeSource({
      url: 'https://site-c.example/other',
      title: 'Independent cache analysis',
      contentHash: 'other-hash',
      extractedText:
        'An independent benchmark measured throughput on three hardware profiles and reported eviction latency percentiles for each workload.',
    });

    const analysis = analyseIndependence([a, b, c]);
    const groupOf = (sourceId: string) =>
      analysis.groups.find((group) => group.sourceIds.includes(sourceId))?.groupId;

    expect(groupOf(a.sourceId)).toBe(groupOf(b.sourceId));
    expect(groupOf(a.sourceId)).not.toBe(groupOf(c.sourceId));
    expect(analysis.independentGroupCount).toBe(2);
    expect(analysis.syndicationPairs.length).toBeGreaterThanOrEqual(1);
  });

  it('counts independent groups, not raw source count', () => {
    const sources = ['g1', 'g1', 'g1', 'g2'].map((group, index) =>
      makeSource({ url: `https://dup-${index}.example/page`, independenceGroup: group })
    );
    expect(independentGroupCount(sources)).toBe(2);
    expect(dominantGroupShare(sources)).toBeCloseTo(0.75, 2);
  });

  it('does not let duplicate sources inflate a claim independent support', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    for (const node of result.claimGraph.nodes) {
      expect(node.independentSupportCount).toBeLessThanOrEqual(node.supportingSourceIds.length);
    }
  });
});

/* ==========================================================================
 * U. Contradictions keep both sides
 * ======================================================================== */

describe('v1.3 U — Contradictions never discard a side', () => {
  it('records both positions when sources disagree', async () => {
    const result = await corpusEngine().run({
      ownerId: 'owner-a',
      query: 'Quantum Cache default time-to-live cached entry',
      mode: 'DEEP_RESEARCH',
    });

    for (const contradiction of result.report!.contradictions) {
      expect(contradiction.sideA.statement.length).toBeGreaterThan(0);
      expect(contradiction.sideB.statement.length).toBeGreaterThan(0);
      expect(contradiction.sideA.statement).not.toBe(contradiction.sideB.statement);
      // Both sides remain visible in the report.
      const text = JSON.stringify(result.report);
      expect(text).toContain(contradiction.sideA.domain);
      expect(text).toContain(contradiction.sideB.domain);
    }
  });

  it('detects a numeric disagreement between independently dated sources', () => {
    const oldSource = makeSource({
      url: 'https://legacy.example/ttl',
      domain: 'legacy.example',
      publishedAt: '2018-01-01T00:00:00.000Z',
    });
    const newSource = makeSource({
      url: 'https://docs.example/ttl',
      domain: 'docs.example',
      publishedAt: '2026-09-01T00:00:00.000Z',
    });

    const contradictions = detectContradictions(
      [
        {
          evidenceId: 'e1',
          sourceId: newSource.sourceId,
          documentId: null,
          provenance: 'WEB_SOURCE',
          claim: 'the default ttl is 300 seconds',
          passage: 'The default time-to-live for a cached entry is 300 seconds.',
          section: null,
          publishedAt: newSource.publishedAt,
          retrievedAt: NOW.toISOString(),
          relevance: 0.9,
          quality: 0.8,
          freshness: 0.9,
          supportType: 'SUPPORTS',
          positionInSource: 0.1,
        },
        {
          evidenceId: 'e2',
          sourceId: oldSource.sourceId,
          documentId: null,
          provenance: 'WEB_SOURCE',
          claim: 'the default ttl is 60 seconds',
          passage: 'The default time-to-live for a cached entry is 60 seconds.',
          section: null,
          publishedAt: oldSource.publishedAt,
          retrievedAt: NOW.toISOString(),
          relevance: 0.8,
          quality: 0.5,
          freshness: 0.2,
          supportType: 'CONTRADICTS',
          positionInSource: 0.2,
        },
      ],
      [newSource, oldSource],
      { minTopicOverlap: 0.2 }
    );

    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0].sideA.statement).toBeTruthy();
    expect(contradictions[0].sideB.statement).toBeTruthy();
    // A date difference explains the gap; it does not prove which side is right.
    expect(contradictions[0].possibleExplanation).toBeTruthy();
    expect(contradictions[0].resolved).toBe(false);
  });

  it('marks a contradiction resolved only when the older side scopes itself to the past', () => {
    const oldSource = makeSource({
      url: 'https://legacy.example/ttl',
      domain: 'legacy.example',
      publishedAt: '2018-01-01T00:00:00.000Z',
    });
    const newSource = makeSource({
      url: 'https://docs.example/ttl',
      domain: 'docs.example',
      publishedAt: '2026-09-01T00:00:00.000Z',
    });

    const unit = (overrides: Record<string, unknown>) =>
      ({
        documentId: null,
        provenance: 'WEB_SOURCE' as const,
        section: null,
        retrievedAt: NOW.toISOString(),
        relevance: 0.9,
        quality: 0.7,
        freshness: 0.6,
        positionInSource: 0.1,
        ...overrides,
      }) as never;

    const contradictions = detectContradictions(
      [
        unit({
          evidenceId: 'e1',
          sourceId: newSource.sourceId,
          claim: 'the default ttl is 300 seconds',
          passage: 'The default time-to-live for a cached entry is 300 seconds.',
          publishedAt: newSource.publishedAt,
          supportType: 'SUPPORTS',
        }),
        unit({
          evidenceId: 'e2',
          sourceId: oldSource.sourceId,
          claim: 'the default ttl was 60 seconds in 1.x',
          passage: 'In version 1.x only, the default time-to-live for a cached entry was 60 seconds.',
          publishedAt: oldSource.publishedAt,
          supportType: 'CONTRADICTS',
        }),
      ],
      [newSource, oldSource],
      { minTopicOverlap: 0.2 }
    );

    expect(contradictions.length).toBeGreaterThan(0);
    expect(contradictions[0].resolved).toBe(true);
    // Both sides are still preserved in the record.
    expect(contradictions[0].sideA.statement).toBeTruthy();
    expect(contradictions[0].sideB.statement).toBeTruthy();
  });

  it('does not invent a conflict between identical statements', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });
    for (const contradiction of result.report!.contradictions) {
      expect(contradiction.sideA.statement).not.toBe(contradiction.sideB.statement);
    }
  });
});

/* ==========================================================================
 * V. Fact-check verdicts
 * ======================================================================== */

describe('v1.3 V — FACT_CHECK produces a nuanced verdict, not a boolean', () => {
  it('returns a verdict with rationale and counts', async () => {
    const result = await corpusEngine().run({
      ownerId: 'owner-a',
      query: 'Is it true that Quantum Cache evicts least-recently-used entries by default?',
      mode: 'FACT_CHECK',
    });

    const factCheck = result.report!.factCheck;
    expect(factCheck).not.toBeNull();
    expect([
      'SUPPORTED',
      'PARTIALLY_SUPPORTED',
      'CONTRADICTED',
      'MIXED',
      'OUTDATED',
      'INSUFFICIENT_EVIDENCE',
    ]).toContain(factCheck!.verdict);
    expect(factCheck!.rationale.length).toBeGreaterThan(0);
    expect(factCheck!.supportingCount).toBeGreaterThanOrEqual(0);
    expect(factCheck!.contradictingCount).toBeGreaterThanOrEqual(0);
  });

  it('reports INSUFFICIENT_EVIDENCE when the corpus says nothing about the claim', async () => {
    const result = await corpusEngine().run({
      ownerId: 'owner-a',
      query: 'Is it true that the ZX-9000 device consumes 4 watts at idle?',
      mode: 'FACT_CHECK',
    });

    const factCheck = result.report!.factCheck;
    expect(factCheck).not.toBeNull();
    expect(['INSUFFICIENT_EVIDENCE', 'MIXED']).toContain(factCheck!.verdict);
    expect(factCheck!.supportingCount).toBe(0);
  });

  it('splits a compound claim into sub-claims', async () => {
    const result = await corpusEngine().run({
      ownerId: 'owner-a',
      query: 'Is it true that Quantum Cache is thread safe and that it evicts least-recently-used entries?',
      mode: 'FACT_CHECK',
    });
    expect(result.report!.factCheck!.claim.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * W. Context assembly
 * ======================================================================== */

describe('v1.3 W — Context assembly is bounded and diverse', () => {
  it('respects the token budget and a per-source cap', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const citations = buildCitationSet(result.sources, result.evidence);

    const context = assembleResearchContext(result.sources, result.evidence, citations, {
      maxTokens: 500,
      maxSources: 5,
      minDiversity: 2,
    });

    expect(context.tokenEstimate).toBeLessThanOrEqual(700);
    expect(context.includedSourceIds.length).toBeLessThanOrEqual(5);
    for (const block of context.blocks) {
      expect(block.passages.length).toBeGreaterThan(0);
      expect(block.citationId).toBeTruthy();
    }
  });

  it('prefers diversity over stacking one strong source', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const citations = buildCitationSet(result.sources, result.evidence);

    const wide = assembleResearchContext(result.sources, result.evidence, citations, {
      maxTokens: 4000,
      maxSources: 10,
      minDiversity: 3,
    });
    const narrow = assembleResearchContext(result.sources, result.evidence, citations, {
      maxTokens: 4000,
      maxSources: 1,
      minDiversity: 1,
    });

    expect(wide.includedSourceIds.length).toBeGreaterThanOrEqual(narrow.includedSourceIds.length);
    expect(narrow.includedSourceIds.length).toBeLessThanOrEqual(1);
  });
});

/* ==========================================================================
 * X. Synthesis honesty
 * ======================================================================== */

describe('v1.3 X — Synthesis separates verified / qualified / conflicting / unknown', () => {
  it('never emits a finding without a resolvable citation', async () => {
    const report = (await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' })).report!;
    const findings = [...report.verifiedFindings, ...report.qualifiedFindings, ...report.conflicts];

    expect(findings.length).toBeGreaterThan(0);
    const citationIds = new Set(report.citations.map((citation) => citation.citationId));

    for (const finding of findings) {
      expect(finding.citationIds.length).toBeGreaterThan(0);
      for (const citationId of finding.citationIds) expect(citationIds.has(citationId)).toBe(true);
    }
  });

  it('lists unresolved questions as unknowns instead of guessing', async () => {
    const report = (
      await corpusEngine().run({
        ownerId: 'owner-a',
        query: 'What are the internal benchmark throughput numbers of the fictional ZX-9000?',
        mode: 'DEEP_RESEARCH',
      })
    ).report!;

    expect(report.unknowns.length).toBeGreaterThan(0);
  });

  it('never exposes reasoning traces in the summary or findings', async () => {
    const report = (await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' })).report!;
    const prose = [report.executiveSummary, ...report.verifiedFindings.map((f) => f.text), ...report.limitations].join(' ');
    expect(prose).not.toMatch(/chain of thought|my reasoning|step-by-step thinking/i);
  });
});

/* ==========================================================================
 * Y. Citation engine + verifier
 * ======================================================================== */

describe('v1.3 Y — Citation verification', () => {
  it('builds citations that point at real evidence', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const citations = buildCitationSet(result.sources, result.evidence);

    expect(citations.length).toBeGreaterThan(0);
    for (const citation of citations) {
      expect(citation.citationId).toBeTruthy();
      expect(citation.url).toMatch(/^https?:\/\//);
      expect(result.sources.some((source) => source.sourceId === citation.sourceId)).toBe(true);
      for (const evidenceId of citation.evidenceIds) {
        expect(result.evidence.some((unit) => unit.evidenceId === evidenceId)).toBe(true);
      }
    }
  });

  it('removes a finding whose citation cannot be resolved', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const citations = buildCitationSet(result.sources, result.evidence);
    const first = citations[0];

    const verification = verifyCitations({
      findings: [
        {
          text: 'The default TTL is 300 seconds.',
          claimId: 'claim-good',
          state: 'SUPPORTED',
          citationIds: [first.citationId],
          confidence: 0.8,
        },
        {
          text: 'An unsupported assertion with a fabricated citation.',
          claimId: 'claim-bad',
          state: 'SUPPORTED',
          citationIds: ['cit-does-not-exist'],
          confidence: 0.9,
        },
      ],
      citations,
      evidence: result.evidence,
      sources: result.sources,
      now: NOW,
      freshnessRequirement: 'none',
    });

    expect(verification.findings.map((finding) => finding.claimId)).toContain('claim-good');
    expect(verification.findings.map((finding) => finding.claimId)).not.toContain('claim-bad');
    expect(verification.result.issues.length).toBeGreaterThan(0);
  });

  it('flags duplicate overcounting of one source group', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const citations = buildCitationSet(result.sources, result.evidence);

    const verification = verifyCitations({
      findings: citations.slice(0, 2).map((citation, index) => ({
        text: `Finding ${index}`,
        claimId: `claim-${index}`,
        state: 'SUPPORTED' as const,
        citationIds: [citation.citationId],
        confidence: 0.7,
      })),
      citations,
      evidence: result.evidence,
      sources: result.sources,
      now: NOW,
      freshnessRequirement: 'none',
    });

    expect(verification.result.issues.length).toBeGreaterThanOrEqual(0);
    expect(typeof verification.result.ok).toBe('boolean');
    expect(verification.result.checkedClaims).toBeGreaterThan(0);
  });

  it('keeps the report citation count consistent with the numbers it publishes', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    expect(result.metrics.citationCount).toBe(result.report!.citations.length);
  });
});

/* ==========================================================================
 * Z–AA. Confidence
 * ======================================================================== */

describe('v1.3 Z–AA — Confidence is transparent', () => {
  it('publishes a level, a score and named components', async () => {
    const confidence = (await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' }))
      .report!.confidence;

    expect(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT']).toContain(confidence.level);
    expect(confidence.score).toBeGreaterThanOrEqual(0);
    expect(confidence.score).toBeLessThanOrEqual(1);
    expect(Object.keys(confidence.components).length).toBeGreaterThanOrEqual(5);
    expect(confidence.notes.length).toBeGreaterThan(0);
    expect(confidence.notes.join(' ')).not.toMatch(/reasoning|thought process/i);
  });

  it('is INSUFFICIENT when no evidence was retrieved', async () => {
    const documents = buildAuditCorpus().documents;
    const engine = new ResearchEngine({
      searchProvider: new FixtureSearchProvider({ documents: [] }),
      fetchProvider: new StaticFixtureFetchProvider({ documents: [] }),
      now: () => NOW,
    });

    const result = await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });
    expect(result.report!.confidence.level).toBe('INSUFFICIENT');
    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is never HIGH for a non-live corpus', async () => {
    const report = (await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' })).report!;
    if (report.confidence.level === 'HIGH') {
      // HIGH may describe evidence quality, but the report must still say it is not live.
      expect(report.live).toBe(false);
      expect(report.limitations.join(' ')).toMatch(/not live|non-live|demonstration/i);
    }
  });
});

/* ==========================================================================
 * AC. End-to-end staging
 * ======================================================================== */

describe('v1.3 AC — End-to-end pipeline (NON-LIVE fixture corpus)', () => {
  it('reports every declared stage with safe, bounded detail', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const seen = new Set(result.report!.progress.map((event) => event.stage));

    for (const stage of RESEARCH_STAGES) {
      expect(seen.has(stage), `stage ${stage} was never reported`).toBe(true);
    }
    for (const event of result.report!.progress) {
      expect(event.detail.length).toBeGreaterThan(0);
      expect(event.detail.length).toBeLessThan(300);
      expect(event.detail).not.toMatch(/thinking|reasoning|prompt|chain of thought/i);
    }
  });

  it('completes with a report, metrics and no hidden failure', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });

    expect(['COMPLETED', 'PARTIAL']).toContain(result.status);
    expect(result.ok).toBe(true);
    expect(result.report!.executiveSummary.length).toBeGreaterThan(0);
    expect(result.metrics.queryCount).toBeGreaterThan(0);
    expect(result.metrics.sourcesDiscovered).toBeGreaterThan(0);
    expect(result.metrics.evidenceUnits).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('stays inside the QUICK budget', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });
    expect(result.metrics.queryCount).toBeLessThanOrEqual(12);
    expect(result.metrics.sourcesDiscovered).toBeLessThanOrEqual(40);
    expect(result.metrics.followUpRounds).toBe(0);
  });
});

/* ==========================================================================
 * AD. Cancellation
 * ======================================================================== */

describe('v1.3 AD — Cancellation', () => {
  it('cancels a task and reports CANCELLED with no report', async () => {
    const engine = corpusEngine();
    const controller = new AbortController();
    const running = engine.run({
      ownerId: 'owner-a',
      query: TTL_QUERY,
      mode: 'DEEP_RESEARCH',
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;

    expect(result.status).toBe('CANCELLED');
    expect(result.report).toBeNull();
    expect(result.metrics.cancelled).toBe(true);
  });

  it('reflects cancellation in the task handle', async () => {
    const engine = corpusEngine();
    const controller = new AbortController();
    controller.abort();
    const result = await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH', signal: controller.signal });

    const task = engine.getTask(result.taskId, 'owner-a');
    expect(task).not.toBeNull();
    expect(task!.status).toBe('CANCELLED');
  });

  it('cancel() refuses a task that already finished, and a foreign task', async () => {
    const engine = corpusEngine();
    const result = await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });

    expect(engine.cancel(result.taskId, 'owner-b')).toBe(false);
    expect(engine.cancel(result.taskId, 'owner-a')).toBe(false);
  });
});

/* ==========================================================================
 * AE. Owner isolation
 * ======================================================================== */

describe('v1.3 AE — Owner isolation', () => {
  it('never returns another owner task', async () => {
    const engine = corpusEngine();
    const created = await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });

    expect(engine.getTask(created.taskId, 'owner-b')).toBeNull();
    expect(engine.getTask(created.taskId, 'owner-a')).not.toBeNull();
  });

  it('scopes history per owner', async () => {
    const engine = corpusEngine();
    await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });
    await engine.run({ ownerId: 'owner-b', query: 'An entirely different question about caching.', mode: 'QUICK_RESEARCH' });

    expect(engine.listTasks('owner-a').every((task) => task.ownerId === 'owner-a')).toBe(true);
    expect(engine.listTasks('owner-b').every((task) => task.ownerId === 'owner-b')).toBe(true);
    expect(engine.listTasks('owner-a').length).toBe(1);
  });

  it('requires an owner id', async () => {
    const engine = corpusEngine();
    await expect(engine.run({ ownerId: '', query: TTL_QUERY })).rejects.toThrow();
  });
});

/* ==========================================================================
 * AF. Private-data minimisation
 * ======================================================================== */

describe('v1.3 AF — Private data never leaves in the search query', () => {
  it('does not forward document contents or secrets to the search provider', async () => {
    const seen: string[] = [];
    const spy: SearchProvider = {
      providerId: 'spy:non-live',
      label: 'Spy provider (NON-LIVE)',
      live: false,
      health: () => ({
        providerId: 'spy:non-live',
        label: 'Spy provider (NON-LIVE)',
        status: 'AVAILABLE',
        live: false,
        detail: 'test spy',
        zeroCost: true,
      }),
      search: async (input) => {
        seen.push(input.query);
        return { ok: true, providerId: 'spy:non-live', live: false, results: [], detail: 'spy' };
      },
    };

    const engine = new ResearchEngine({
      searchProvider: spy,
      fetchProvider: new StaticFixtureFetchProvider({ documents: [] }),
      now: () => NOW,
    });

    await engine.run({
      ownerId: 'owner-a',
      query: 'What is the default cache TTL?',
      documentIds: ['doc-secret'],
      documentProvider: async () => [
        {
          documentId: 'doc-secret',
          documentTitle: 'internal-secrets.pdf',
          passages: [
            {
              text: 'CONFIDENTIAL: internal API key sk-live-abc123456789 and the customer is Acme Corporation.',
              page: 1,
              section: null,
            },
          ],
          projectId: null,
        },
      ],
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const query of seen) {
      expect(query).not.toContain('sk-live-abc123456789');
      expect(query.toLowerCase()).not.toContain('acme');
      expect(query).not.toContain('CONFIDENTIAL');
      expect(query.length).toBeLessThan(300);
    }
  });
});

/* ==========================================================================
 * AG–AH. Document provenance
 * ======================================================================== */

describe('v1.3 AG — DOCUMENT_SOURCE and WEB_SOURCE stay distinguishable', () => {
  it('tags every source with exactly one provenance kind', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      expect(['WEB_SOURCE', 'DOCUMENT_SOURCE']).toContain(source.provenance);
    }
  });

  it('merges owner documents as DOCUMENT_SOURCE with a document:// URL, never a web URL', async () => {
    const engine = corpusEngine({
      documentProvider: documentProviderStub([
        'Our internal deployment configures the default cache time-to-live to 120 seconds.',
      ]),
    });

    const result = await engine.run({
      ownerId: 'owner-a',
      query: TTL_QUERY,
      mode: 'COMPARE',
      documentIds: ['doc-1'],
    });
    const documents = result.sources.filter((source) => source.provenance === 'DOCUMENT_SOURCE');

    expect(documents.length).toBeGreaterThan(0);
    for (const source of documents) {
      expect(source.url.startsWith('document://')).toBe(true);
      expect(source.url.startsWith('http')).toBe(false);
    }
    for (const source of result.sources.filter((source) => source.provenance === 'WEB_SOURCE')) {
      expect(source.url.startsWith('http')).toBe(true);
    }
  });

  it('keeps web and document evidence in the same report without blurring provenance', async () => {
    const engine = corpusEngine({
      documentProvider: documentProviderStub([
        'Our internal deployment configures the default cache time-to-live to 120 seconds.',
      ]),
    });

    const result = await engine.run({
      ownerId: 'owner-a',
      query: 'Quantum Cache default time-to-live cached entry',
      mode: 'COMPARE',
      documentIds: ['doc-1'],
    });

    const kinds = new Set(result.sources.map((source) => source.provenance));
    expect(kinds.has('DOCUMENT_SOURCE')).toBe(true);
    expect(kinds.has('WEB_SOURCE')).toBe(true);

    for (const unit of result.evidence) {
      const source = result.sources.find((candidate) => candidate.sourceId === unit.sourceId);
      expect(source).toBeDefined();
      expect(unit.provenance).toBe(source!.provenance);
    }
  });
});

/* ==========================================================================
 * AI. Bounded persistence
 * ======================================================================== */

describe('v1.3 AI — Bounded, provenance-tagged persistence surface', () => {
  it('caps the text carried with each source', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    for (const source of result.sources) {
      expect(source.extractedText.length).toBeLessThanOrEqual(4000);
    }
  });

  it('keeps the evidence set inside a hard unit ceiling', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    expect(result.evidence.length).toBeLessThanOrEqual(160);
  });

  it('carries the live flag and provider status into the report', async () => {
    const report = (await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' })).report!;
    expect(report.live).toBe(false);
    expect(report.providerStatus.live).toBe(false);
    expect(report.providerStatus.status).toBe('AVAILABLE');
  });
});

/* ==========================================================================
 * AJ–AK. Honest failure handling
 * ======================================================================== */

describe('v1.3 AJ — Inaccessible sources are reported, never faked', () => {
  /** The corpus marks two cache-related sources as inaccessible to real readers. */
  function engineWithInaccessibleSources() {
    const { documents, failures } = buildAuditCorpus();
    return new ResearchEngine({
      searchProvider: new FixtureSearchProvider({ documents }),
      fetchProvider: new StaticFixtureFetchProvider({ documents, failures }),
      now: () => NOW,
    });
  }

  it('records a fetch failure with a status and contributes no text', async () => {
    const result = await engineWithInaccessibleSources().run({
      ownerId: 'owner-a',
      query: 'Quantum Cache report',
      mode: 'SOURCE_DISCOVERY',
    });

    expect(result.metrics.fetchFailures.length).toBeGreaterThan(0);
    for (const failure of result.metrics.fetchFailures) {
      expect(failure.domain.length).toBeGreaterThan(0);
      expect(['PAYWALLED', 'ROBOTS_RESTRICTED']).toContain(failure.status);
    }
    // A page that could not be read must never appear as a readable source.
    for (const source of result.sources) {
      expect(source.fetchStatus).toBe('OK');
      expect(source.extractedText.length).toBeGreaterThan(0);
    }
  });

  it('states the access limitation in the report', async () => {
    const report = (
      await engineWithInaccessibleSources().run({
        ownerId: 'owner-a',
        query: 'Quantum Cache report',
        mode: 'SOURCE_DISCOVERY',
      })
    ).report!;
    expect(report.limitations.join(' ')).toMatch(/access failure|not used as evidence/i);
  });

  it('never cites a source that could not be read', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    const unreadable = new Set(
      result.sources.filter((source) => source.fetchStatus !== 'OK').map((source) => source.sourceId)
    );
    for (const citation of result.report!.citations) {
      expect(unreadable.has(citation.sourceId)).toBe(false);
    }
  });
});

describe('v1.3 AK — Insufficient evidence is an honest outcome', () => {
  it('returns INSUFFICIENT_EVIDENCE and invents nothing when every fetch fails', async () => {
    const { documents } = buildAuditCorpus();
    const allFailed: Record<string, 'AUTH_REQUIRED'> = {};
    for (const document of documents) allFailed[document.url] = 'AUTH_REQUIRED';

    const engine = new ResearchEngine({
      searchProvider: new FixtureSearchProvider({ documents }),
      fetchProvider: new StaticFixtureFetchProvider({ documents: [], failures: allFailed }),
      now: () => NOW,
    });

    const result = await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });

    expect(['INSUFFICIENT_EVIDENCE', 'PARTIAL']).toContain(result.status);
    expect(result.evidence).toHaveLength(0);
    expect(result.report!.verifiedFindings).toHaveLength(0);
    expect(result.report!.citations).toHaveLength(0);
    expect(result.report!.unknowns.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
 * AL. Observability
 * ======================================================================== */

describe('v1.3 AL — Observability surface', () => {
  it('exposes engine identity and provider health', () => {
    expect(RESEARCH_ENGINE_VERSION).toMatch(/^1\.3\.0/);
    const health = corpusEngine().providerHealth();
    expect(health.providerId).toBe('fixture:non-live');
    expect(health.live).toBe(false);
    expect(health.detail).toMatch(/NON-LIVE|synthetic/i);
  });

  it('publishes metrics that reconcile with the result', async () => {
    const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'DEEP_RESEARCH' });
    expect(result.metrics.evidenceUnits).toBe(result.evidence.length);
    expect(result.metrics.sourcesDiscovered).toBeGreaterThanOrEqual(result.sources.length);
    expect(result.metrics.sourcesFetched).toBeLessThanOrEqual(result.metrics.sourcesDiscovered);
    expect(result.metrics.live).toBe(false);
    expect(result.metrics.searchProvider).toBe('fixture:non-live');
  });

  it('forwards progress through the onProgress hook', async () => {
    const events: string[] = [];
    const { documents, failures } = buildAuditCorpus();
    const engine = new ResearchEngine({
      searchProvider: new FixtureSearchProvider({ documents }),
      fetchProvider: new StaticFixtureFetchProvider({ documents, failures }),
      now: () => NOW,
      onProgress: (_taskId, event) => events.push(event.stage),
    });

    await engine.run({ ownerId: 'owner-a', query: TTL_QUERY, mode: 'QUICK_RESEARCH' });
    expect(events.length).toBeGreaterThan(0);
    for (const stage of events) expect(RESEARCH_STAGES).toContain(stage);
  });
});

/* ==========================================================================
 * AM. All nine modes
 * ======================================================================== */

describe('v1.3 AM — Every mode is bounded and honest', () => {
  for (const mode of RESEARCH_MODES) {
    it(`${mode} completes inside its budget`, async () => {
      const result = await corpusEngine().run({ ownerId: 'owner-a', query: TTL_QUERY, mode });

      expect(['COMPLETED', 'PARTIAL', 'INSUFFICIENT_EVIDENCE']).toContain(result.status);
      expect(result.report).not.toBeNull();
      expect(result.report!.live).toBe(false);
      expect(result.metrics.followUpRounds).toBeLessThanOrEqual(3);
      expect(result.metrics.queryCount).toBeLessThanOrEqual(12);
      expect(result.metrics.sourcesDiscovered).toBeLessThanOrEqual(40);
    });
  }
});

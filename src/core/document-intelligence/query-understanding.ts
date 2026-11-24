/**
 * JARVIS-X v1.2.0 — Query Understanding
 *
 * Classifies document questions so the retrieval strategy can adapt. Purely
 * deterministic and explainable — no hidden reasoning is exposed.
 */

import type { QueryIntent, QueryUnderstanding } from './types';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'about', 'from', 'as', 'into', 'what', 'which', 'who', 'whom', 'whose',
  'when', 'where', 'why', 'how', 'can', 'could', 'should', 'would', 'will',
  'i', 'you', 'we', 'they', 'it', 'he', 'she', 'my', 'your', 'our', 'their',
  'me', 'us', 'them', 'please', 'tell', 'show', 'give',
]);

const COMPARISON_CUES = [
  /\bcompare\b/i,
  /\bversus\b/i,
  /\bvs\.?\b/i,
  /\bdifference(s)? between\b/i,
  /\bwhat changed between\b/i,
  /\bcontradict/i,
  /\bdisagree/i,
  /\bconflict/i,
];

const SUMMARY_CUES = [
  /\bsummari[sz]e\b/i,
  /\bsummary\b/i,
  /\boverview\b/i,
  /\bkey points\b/i,
  /\btl;?dr\b/i,
  /\bmain (points|ideas|takeaways)\b/i,
  /\baction items\b/i,
];

const EXTRACTION_CUES = [
  /\bextract\b/i,
  /\blist all\b/i,
  /\bfind all\b/i,
  /\benumerate\b/i,
  /\bwhat are the .* (fields|columns|keys)\b/i,
];

const EXPLANATION_CUES = [
  /\bexplain\b/i,
  /\bwhy\b/i,
  /\bhow does\b/i,
  /\bhow do\b/i,
  /\bdescribe\b/i,
  /\bwalk me through\b/i,
];

const TABLE_CUES = [
  /\btable\b/i,
  /\bcolumn(s)?\b/i,
  /\brow(s)?\b/i,
  /\bcsv\b/i,
  /\bdata(set)?\b/i,
  /\bhow many\b/i,
  /\baverage\b/i,
  /\bmean\b/i,
  /\bmax(imum)?\b/i,
  /\bmin(imum)?\b/i,
];

const CODE_CUES = [
  /\bfunction\b/i,
  /\bclass\b/i,
  /\bapi\b/i,
  /\bendpoint\b/i,
  /\bimplement/i,
  /\binterface\b/i,
  /\bconfigur/i,
  /\bschema\b/i,
  /\bcode\b/i,
];

const CROSS_DOC_CUES = [
  /\bacross\b.*\bdocuments?\b/i,
  /\ball (the )?documents?\b/i,
  /\bthese documents?\b/i,
  /\bboth documents?\b/i,
  /\bmultiple documents?\b/i,
];

function extractKeywords(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  // Preserve order, deduplicate.
  return [...new Set(tokens)].slice(0, 24);
}

function extractEntities(query: string): string[] {
  const entities = new Set<string>();
  // Quoted phrases
  for (const m of query.matchAll(/"([^"]{2,60})"/g)) entities.add(m[1]);
  // Identifiers / numbered refs
  for (const m of query.matchAll(/\b([A-Z]{2,}(?:-[A-Z0-9]+)*)\b/g)) entities.add(m[1]);
  for (const m of query.matchAll(/\b(v?\d+(?:\.\d+)+)\b/g)) entities.add(m[1]);
  return [...entities].slice(0, 12);
}

export function understandQuery(query: string): QueryUnderstanding {
  const q = query.trim();
  const keywords = extractKeywords(q);
  const entities = extractEntities(q);

  const wantsComparison = COMPARISON_CUES.some((p) => p.test(q));
  const wantsSummary = SUMMARY_CUES.some((p) => p.test(q));
  const wantsExtraction = EXTRACTION_CUES.some((p) => p.test(q));
  const wantsExplanation = EXPLANATION_CUES.some((p) => p.test(q));
  const wantsTable = TABLE_CUES.some((p) => p.test(q));
  const wantsCode = CODE_CUES.some((p) => p.test(q));
  const wantsCrossDoc = CROSS_DOC_CUES.some((p) => p.test(q));

  let intent: QueryIntent;
  let rationale: string;

  if (wantsComparison) {
    intent = 'comparison';
    rationale = 'Comparison/contradiction cue detected — retrieval must span multiple documents.';
  } else if (wantsCrossDoc) {
    intent = 'cross_document_synthesis';
    rationale = 'Cross-document cue detected — evidence from several documents will be combined.';
  } else if (wantsSummary) {
    intent = 'summarization';
    rationale = 'Summarization cue detected — broad coverage beats precision.';
  } else if (wantsTable) {
    intent = 'table_data';
    rationale = 'Tabular/data cue detected — table and row chunks are prioritised.';
  } else if (wantsExtraction) {
    intent = 'extraction';
    rationale = 'Extraction cue detected — recall across the corpus is prioritised.';
  } else if (wantsCode) {
    intent = 'code_documentation';
    rationale = 'Code/documentation cue detected — code and spec chunks are prioritised.';
  } else if (wantsExplanation) {
    intent = 'explanation';
    rationale = 'Explanation cue detected — semantically related passages are prioritised.';
  } else {
    intent = 'factual_lookup';
    rationale = 'Default factual lookup — precise, high-scoring passages are prioritised.';
  }

  return {
    intent,
    keywords,
    entities,
    wantsComparison,
    wantsSummary,
    rationale,
  };
}

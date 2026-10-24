# JARVIS-X — Personal Multimodal AI Agent (`1.0.0-multimodal`)

JARVIS-X is a modular, security-first personal multimodal AI architecture combining a bounded state-machine runtime, provider-agnostic multi-model intelligence, 7-scope hierarchical memory, female vocal persona synthesis with full-duplex barge-in, binary vision frame inspection, structured document intelligence, and Supabase PostgreSQL 17 `FORCE ROW LEVEL SECURITY` persistence.

## Run It — Website

The site opens straight into a chat surface at `/` (the full command HUD stays at `/dashboard`).
No API key, no login, and no credit card are required — it runs on the zero-cost local
`Foundation Deterministic Core`.

- **Deploy for a permanent public URL (2 min):** [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fng273499-svg%2FMy-2)
- **Run locally:** `npm install && npm run build && npm start` → http://localhost:3000
- **Full instructions:** see [DEPLOY.md](./DEPLOY.md)

## Core Capabilities (`v1.0.0-multimodal`)

- **Core Runtime Orchestrator (`src/core/runtime/`)**: Bounded 12-state agent state machine (`RECEIVED` → `COMPLETED | AWAITING_APPROVAL | FAILED | CANCELLED`), 10 capability contracts, 10 specialist contracts (including `OPERATIONAL_LOCAL` `PlanningAgent`, `MemoryAgent`, `VerificationAgent`, `DataAgent`, `CybersecurityAgent`, `CodingAgent`), 4-tier risk & permission gating, and outcome verification (`VerificationLayer`).
- **Voice & Female Persona Engine (`src/core/voice/`, `src/lib/browser-voice.ts`)**: `Aria` (Warm Contralto) and `Lyra` (Crisp Tactical) female vocal profiles modulated across 8 conversational response styles (`calm`, `excitement`, `concern`, `curiosity`, `confidence`, `seriousness`, `humor`, `urgency`), markdown/UUID/code-block spoken normalization, full-duplex `VoiceBargeInController`, zero-cost Browser Web Speech synthesis, and server-side `OpenAISpeechAdapter` (`nova`/`shimmer` + Whisper when configured).
- **Vision & Camera Frame Pipeline (`src/core/vision/`, `src/core/modules/vision-engine/`)**: Deterministic zero-dependency binary header & geometry verification (`PNG`, `JPEG`, `GIF`, `WebP`, `SVG` dimensions, aspect ratio, orientation, and SVG text labels), live `<canvas>` camera frame capture in `VisionInspectorModal`, and multimodal base64 image forwarding to `OpenAI`, `Anthropic`, and `Gemini` Vision adapters when configured — never fabricating scene content when unconfigured (`PARTIAL_LOCAL`).
- **Document & File Intelligence Engine (`src/core/files/`)**: Structured local analysis for `Markdown`, `CSV`, `TSV`, `JSON`, source code, and plain text (numeric CSV min/max/mean profiling, JSON schema profiling, heading & symbol extraction, semantic chunking), `PromptInjectionBoundary` quarantine, and `knowledge`-scope ingestion (`provenance: 'untrusted_external'`), while honestly reporting `NOT_AVAILABLE` on unattached external files or binary PDFs.
- **7-Scope Hierarchical Memory Engine (`src/core/memory/`)**: `working`, `episodic`, `semantic`, `project`, `knowledge`, `procedural`, and `event` scopes with Ebbinghaus temporal decay, contradiction supersession lineage, deterministic 1536-dim local vector fallback + OpenAI neural embeddings when configured, and non-CoT episodic consolidation.
- **Provider-Agnostic Multi-Model Router (`src/core/models/`)**: `FoundationLocalProviderAdapter` (always-online zero-cost baseline) + `OpenAI`, `Anthropic`, `Gemini`, and `OpenAICompatible` adapters, 5 routing policies (`AUTO_BALANCED`, `QUALITY_FIRST`, `SPEED_FIRST`, `COST_AWARE`, `MANUAL`), circuit breakers, and bounded fallback chains.
- **Governed Proactive Workflows (`/api/jarvis/workflows`, `proactive-monitoring-engine`)**: Per-user workflow definitions (`manual`, `session_start`, `interval_advisory`, `event_watch`) that always execute through `JarvisCoreRuntime` + `PermissionManager` and never bypass approval gates.

## Supabase Persistence & Security (`supabase/migrations/` & `src/server/`)

- **6 Applied Migrations**:
  1. `supabase/migrations/20261022000001_jarvis_x_foundation.sql`
  2. `supabase/migrations/20261022000002_jarvis_x_audit_rls_pgvector.sql`
  3. `supabase/migrations/20261022000003_jarvis_x_core_runtime_tasks.sql`
  4. `supabase/migrations/20261022000004_jarvis_x_routing_policy.sql`
  5. `supabase/migrations/20261022000005_jarvis_x_hierarchical_memory.sql`
  6. `supabase/migrations/20261022000006_jarvis_x_multimodal_workflows.sql`
- **12 FORCE-RLS Tables**:
  - `user_profiles`, `projects`, `conversations`, `conversation_messages`, `long_term_memories` (`vector(1536)` + HNSW cosine index + `match_long_term_memories` & `match_hierarchical_memories` `SECURITY INVOKER` RPCs), `agent_tasks`, `connected_tools`, `preferences`, `permission_records`, append-only `audit_logs`, `ingested_documents`, and `proactive_workflows`.
- **Server-Only Secret Isolation**:
  - `SUPABASE_SERVICE_ROLE_KEY` and all AI provider keys stay strictly server-only (`import 'server-only'`). User data operations bind the operator's JWT so PostgreSQL enforces `auth.uid() = user_id` on every query.

## Verification & Local Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

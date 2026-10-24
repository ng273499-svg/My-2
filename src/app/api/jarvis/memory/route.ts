import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PREPARED_MEMORY_SCOPES } from '@/core/runtime/memory-context';
import { getJarvisCoreForRequest } from '@/server/runtime';

const MemoryScopeEnum = z.enum([
  'working',
  'episodic',
  'semantic',
  'project',
  'knowledge',
  'procedural',
  'event',
]);

const MemoryCategoryEnum = z.enum([
  'fact',
  'preference',
  'project_context',
  'episodic_summary',
  'workflow',
  'knowledge_chunk',
  'event_record',
]);

const StoreMemorySchema = z.object({
  action: z.literal('store').optional(),
  content: z.string().min(2).max(4000),
  category: MemoryCategoryEnum.optional(),
  memoryScope: MemoryScopeEnum.optional(),
  projectId: z.string().nullable().optional(),
  importance: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]).optional(),
  tags: z.array(z.string().max(48)).max(12).optional(),
  provenance: z
    .enum([
      'user_explicit',
      'operator_manual',
      'episodic_consolidation',
      'system_seed',
      'untrusted_external',
    ])
    .optional(),
  expiresAt: z.string().nullable().optional(),
});

const ConsolidateSessionSchema = z.object({
  action: z.literal('consolidate'),
  conversationId: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

const MemoryPostSchema = z.union([ConsolidateSessionSchema, StoreMemorySchema]);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scopeParam = searchParams.get('scope');
    const projectIdParam = searchParams.get('projectId');
    const includeSuperseded = searchParams.get('includeSuperseded') === 'true';
    const query = searchParams.get('q');

    const parsedScope = scopeParam
      ? MemoryScopeEnum.safeParse(scopeParam)
      : null;
    if (parsedScope && !parsedScope.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid memory scope filter.' },
        { status: 400 }
      );
    }

    const { actor, jarvis } = await getJarvisCoreForRequest(request);
    const snapshot = await jarvis.getSystemSnapshot();

    if (query && query.trim().length > 0) {
      const retrieval = await jarvis.memoryManager.retrieveHierarchicalBundle(
        actor.userId,
        {
          query: query.trim(),
          projectId: projectIdParam ?? undefined,
          scopes: parsedScope?.success ? [parsedScope.data] : undefined,
          includeSuperseded,
        }
      );

      return NextResponse.json({
        ok: true,
        memory: snapshot.memory,
        scopes: PREPARED_MEMORY_SCOPES,
        entries: retrieval.entries,
        retrieval: {
          totalTokensEstimated: retrieval.totalTokensEstimated,
          countsByScope: retrieval.countsByScope,
          untrustedItemsQuarantined: retrieval.untrustedItemsQuarantined,
          expiredFilteredOut: retrieval.expiredFilteredOut,
          supersededFilteredOut: retrieval.supersededFilteredOut,
          injectionWarnings: retrieval.injectionWarnings,
        },
      });
    }

    const filteredEntries =
      parsedScope?.success || includeSuperseded || projectIdParam !== null
        ? await jarvis.memoryManager.listEntries(actor.userId, {
            scope: parsedScope?.success ? parsedScope.data : undefined,
            projectId: projectIdParam !== null ? projectIdParam : undefined,
            includeSuperseded,
          })
        : snapshot.recentMemories;

    return NextResponse.json({
      ok: true,
      memory: snapshot.memory,
      scopes: PREPARED_MEMORY_SCOPES,
      entries: filteredEntries,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Memory read failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = MemoryPostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: 'Invalid memory payload.' },
        { status: 400 }
      );
    }

    const { actor, jarvis } = await getJarvisCoreForRequest(request);

    if (parsed.data.action === 'consolidate') {
      const consolidation = await jarvis.consolidateConversationMemory(
        parsed.data.conversationId,
        parsed.data.projectId
      );
      const snapshot = await jarvis.getSystemSnapshot(parsed.data.conversationId);
      return NextResponse.json({
        ok: true,
        consolidation,
        snapshot,
      });
    }

    const outcome = await jarvis.memoryManager.storeMemoryWithOutcome(
      actor.userId,
      {
        category: parsed.data.category ?? 'fact',
        memoryScope: parsed.data.memoryScope,
        projectId: parsed.data.projectId ?? null,
        content: parsed.data.content,
        tags: parsed.data.tags ?? ['manual-entry'],
        importance: parsed.data.importance ?? 4,
        provenance: parsed.data.provenance ?? 'operator_manual',
        expiresAt: parsed.data.expiresAt ?? null,
      }
    );

    if (!outcome.entry) {
      return NextResponse.json(
        { ok: false, error: outcome.reason, outcome },
        { status: 422 }
      );
    }

    const snapshot = await jarvis.getSystemSnapshot();

    return NextResponse.json({
      ok: true,
      entry: outcome.entry,
      outcome,
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Memory write failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { ok: false, error: 'Missing memory id.' },
        { status: 400 }
      );
    }

    const { jarvis } = await getJarvisCoreForRequest(request);
    await jarvis.removeMemory(id);
    const snapshot = await jarvis.getSystemSnapshot();

    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Memory delete failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

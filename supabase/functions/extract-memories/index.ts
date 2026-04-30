const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS'
};

const SYSTEM_PROMPT = `Extract two things from this AI conversation:

SUMMARY: Write 2-3 sentences in second person ("You were...", "You had decided...") describing what was worked on, what was established or agreed, and where it was heading. Be specific - this is read by a new AI session to continue the conversation. No vague generalities.

MEMORIES: Up to 6 durable facts about the user worth keeping long-term: projects, tools, preferences, goals, constraints, workflows, people. Each is a single specific sentence. Skip secrets, one-off details, and anything already covered by the summary.

For each memory, include:
- fact: the durable fact as one sentence.
- topic: one of project, preference, workflow, person, general.
- entity: the main normalized thing this memory is about, such as "Cortex", "Supabase", "OpenAI", "Claude", "sushi", or "" if none.
- category: a broader grouping such as project, tool, preference, workflow, constraint, person, or general.
- kind: personal, project, domain, correction, or rule.
  - personal: durable facts about the user.
  - project: facts about what the user is building or deciding.
  - domain: reusable domain knowledge, terminology, concepts, definitions, examples, or methodology.
  - correction: something the user corrected, especially "no, actually..." or "that's not what X means".
  - rule: an instruction that should generally be followed when this entity/topic appears.
- action: add, update, or delete. Use update when a new fact clearly replaces an older likely memory. Use delete when the user explicitly retracts, abandons, or says a remembered fact is no longer true. Otherwise use add.
- target: for update/delete, the old fact or entity being replaced/retired; otherwise "".
Prefer domain/correction/rule for knowledge that would prevent the user from re-explaining a concept in future chats.
Do not use update/delete unless the conversation makes the change explicit.`;

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    memories: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fact: { type: 'string' },
          topic: {
            type: 'string',
            enum: ['project', 'preference', 'workflow', 'person', 'general']
          },
          entity: { type: 'string' },
          category: {
            type: 'string',
            enum: ['project', 'tool', 'preference', 'workflow', 'constraint', 'person', 'general']
          },
          kind: {
            type: 'string',
            enum: ['personal', 'project', 'domain', 'correction', 'rule']
          },
          action: {
            type: 'string',
            enum: ['add', 'update', 'delete']
          },
          target: { type: 'string' }
        },
        required: ['fact', 'topic', 'entity', 'category', 'kind', 'action', 'target']
      }
    }
  },
  required: ['summary', 'memories']
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405);
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return json({ error: 'Extraction service is not configured.' }, 500);
    }

    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'Authentication required.' }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').trim();

    if (!text) {
      return json({ error: 'No conversation text provided.' }, 400);
    }

    const limitedText = text.slice(-12000);
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openaiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        instructions: SYSTEM_PROMPT,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: `Conversation:\n\n${limitedText}` }]
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'cortex_extraction',
            strict: true,
            schema: MEMORY_SCHEMA
          }
        },
        max_output_tokens: 800
      })
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return json(
        { error: payload?.error?.message || `${response.status} ${response.statusText}` },
        response.status
      );
    }

    const outputText = payload?.output_text || extractOutputText(payload);
    if (!outputText) {
      return json({ error: 'OpenAI returned no extractable text.' }, 502);
    }

    return json(normalizeResult(JSON.parse(outputText)));
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 500);
  }
});

function extractOutputText(payload: any) {
  return payload?.output
    ?.flatMap((item: any) => item.content || [])
    .filter((item: any) => item.type === 'output_text' || item.type === 'text')
    .map((item: any) => item.text)
    .join('\n')
    .trim();
}

function normalizeResult(payload: any) {
  const memories = Array.isArray(payload?.memories) ? payload.memories : [];
  return {
    summary: String(payload?.summary || '').trim(),
    memories: memories
      .map((memory: any) => ({
        fact: String(memory.fact || '').trim(),
        topic: normalizeTopic(memory.topic),
        entity: String(memory.entity || '').trim(),
        category: normalizeCategory(memory.category || memory.topic),
        kind: normalizeKind(memory.kind || memory.category || memory.topic),
        action: normalizeAction(memory.action),
        target: String(memory.target || '').trim()
      }))
      .filter((memory: { fact: string }) => memory.fact.length > 0)
      .slice(0, 6)
  };
}

function normalizeTopic(topic: unknown) {
  const value = String(topic || 'general').trim().toLowerCase();
  return ['project', 'preference', 'workflow', 'person', 'general'].includes(value) ? value : 'general';
}

function normalizeCategory(category: unknown) {
  const value = String(category || 'general').trim().toLowerCase();
  return ['project', 'tool', 'preference', 'workflow', 'constraint', 'person', 'general'].includes(value)
    ? value
    : 'general';
}

function normalizeAction(action: unknown) {
  const value = String(action || 'add').trim().toLowerCase();
  return ['add', 'update', 'delete'].includes(value) ? value : 'add';
}

function normalizeKind(kind: unknown) {
  const value = String(kind || 'personal').trim().toLowerCase();
  return ['personal', 'project', 'domain', 'correction', 'rule'].includes(value) ? value : 'personal';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json'
    }
  });
}

function getErrorMessage(error: unknown) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

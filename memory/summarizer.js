import SettingsManager from './settings.js';
import { supabase } from '../utils/supabase.js';

const SYSTEM_PROMPT = `Extract two things from this AI conversation:

SUMMARY: Write 2-3 sentences in second person ("You were...", "You had decided...") describing what was worked on, what was established or agreed, and where it was heading. Be specific - this is read by a new AI session to continue the conversation. No vague generalities.

MEMORIES: Up to 6 durable facts about the user worth keeping long-term: projects, tools, preferences, goals, constraints, workflows, people. Each is a single specific sentence. Skip secrets, one-off details, and anything already covered by the summary.

For each memory, include:
- fact: the durable fact as one sentence.
- topic: one of project, preference, workflow, person, general.
- entity: the main normalized thing this memory is about, such as "mynd", "Supabase", "OpenAI", "Claude", "sushi", or "" if none.
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

const JSON_INSTRUCTION = `Return strict JSON only - no other text:
{"summary":"...","memories":[{"fact":"...","topic":"...","entity":"...","category":"...","kind":"project","action":"add","target":""}]}`;

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

// Returns { summary: string, memories: Array<{fact, topic}> }
const Summarizer = {
  extractMemories: async (conversationText) => {
    const text = conversationText.trim();
    if (!text) throw new Error('No conversation text to extract from.');

    const settings = await SettingsManager.getSettings();

    if (settings.provider === 'default') {
      return extractWithDefaultService(text);
    }

    if (settings.provider === 'chrome-ai') {
      return extractWithChromeAI(text);
    }

    return extractWithDefaultService(text);
  }
};

// ---------------------------------------------------------------------------
// DEFAULT mynd SERVICE
// Keeps provider keys off the client. Supabase Edge Function owns the OpenAI key.
// ---------------------------------------------------------------------------
async function extractWithDefaultService(conversationText) {
  const { data, error } = await supabase.functions.invoke('extract-memories', {
    body: { text: conversationText }
  });

  if (error) {
    throw new Error(error.message || 'Default extraction service failed.');
  }

  return normalizeResult(data);
}

// ---------------------------------------------------------------------------
// CHROME BUILT-IN AI
// ---------------------------------------------------------------------------
async function extractWithChromeAI(conversationText) {
  const model = getChromeLanguageModel();

  if (!model) {
    throw new Error(
      'Chrome Prompt AI is not available. Enable the Prompt API flags, restart Chrome, or switch provider in settings.'
    );
  }

  await assertChromeAIAvailable(model);

  const session = await createChromeAISession(model);
  const raw = await session.prompt(`Conversation:\n\n${conversationText}`);
  session.destroy?.();

  return normalizeResult(JSON.parse(extractJsonObject(raw)));
}

function getChromeLanguageModel() {
  return globalThis.LanguageModel ??
    globalThis.ai?.languageModel ??
    globalThis.ai?.assistant ??
    null;
}

async function assertChromeAIAvailable(model) {
  if (typeof model.availability === 'function') {
    const availability = await model.availability().catch(() => null);
    if (availability === 'unavailable') {
      throw new Error('Chrome Prompt AI is unavailable on this browser/device.');
    }
  }

  if (typeof model.capabilities === 'function') {
    const capabilities = await model.capabilities();
    if (capabilities?.available === 'no') {
      throw new Error('Chrome Prompt AI model is not downloaded yet. Check chrome://on-device-internals.');
    }
  }
}

async function createChromeAISession(model) {
  if (globalThis.LanguageModel && model === globalThis.LanguageModel) {
    return model.create({
      initialPrompts: [{ role: 'system', content: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` }]
    });
  }
  return model.create({ systemPrompt: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` });
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('Model did not return JSON.');
  return text.slice(start, end + 1);
}

function normalizeResult(payload) {
  const summary = String(payload?.summary || '').trim();
  const memories = Array.isArray(payload?.memories) ? payload.memories : [];
  return {
    summary,
    memories: memories
      .map((m) => ({
        fact: String(m.fact || '').trim(),
        topic: normalizeTopic(m.topic),
        entity: String(m.entity || '').trim(),
        category: normalizeCategory(m.category || m.topic),
        kind: normalizeKind(m.kind || m.category || m.topic),
        action: normalizeAction(m.action),
        target: String(m.target || '').trim()
      }))
      .filter((m) => m.fact.length > 0)
      .slice(0, 6)
  };
}

function normalizeTopic(topic) {
  const value = String(topic || 'general').trim().toLowerCase();
  return ['project', 'preference', 'workflow', 'person', 'general'].includes(value) ? value : 'general';
}

function normalizeCategory(category) {
  const value = String(category || 'general').trim().toLowerCase();
  return ['project', 'tool', 'preference', 'workflow', 'constraint', 'person', 'general'].includes(value) ? value : 'general';
}

function normalizeAction(action) {
  const value = String(action || 'add').trim().toLowerCase();
  return ['add', 'update', 'delete'].includes(value) ? value : 'add';
}

function normalizeKind(kind) {
  const value = String(kind || 'personal').trim().toLowerCase();
  return ['personal', 'project', 'domain', 'correction', 'rule'].includes(value) ? value : 'personal';
}

export default Summarizer;

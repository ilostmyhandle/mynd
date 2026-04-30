import SettingsManager from './settings.js';
import { supabase } from '../utils/supabase.js';

const SYSTEM_PROMPT = `Extract two things from this AI conversation:

SUMMARY: Write 2-3 sentences in second person ("You were...", "You had decided...") describing what was worked on, what was established or agreed, and where it was heading. Be specific - this is read by a new AI session to continue the conversation. No vague generalities.

MEMORIES: Up to 6 durable facts about the user worth keeping long-term: projects, tools, preferences, goals, constraints, workflows, people. Each is a single specific sentence. Skip secrets, one-off details, and anything already covered by the summary.`;

const JSON_INSTRUCTION = `Return strict JSON only - no other text:
{"summary":"...","memories":[{"fact":"...","topic":"..."}]}
Topic must be one of: project, preference, workflow, person, general.`;

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
          topic: { type: 'string' }
        },
        required: ['fact', 'topic']
      }
    }
  },
  required: ['summary', 'memories']
};

// Gemini rejects additionalProperties; use a stripped schema.
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    memories: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          fact: { type: 'string' },
          topic: {
            type: 'string',
            enum: ['project', 'preference', 'workflow', 'person', 'general']
          }
        },
        required: ['fact', 'topic']
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

    if (!settings.apiKey) throw new Error('Add your API key in settings first.');

    if (settings.provider === 'gemini') return extractWithGemini(text, settings);
    if (settings.provider === 'anthropic') return extractWithAnthropic(text, settings);
    return extractWithOpenAI(text, settings);
  }
};

// ---------------------------------------------------------------------------
// DEFAULT CORTEX SERVICE
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

// ---------------------------------------------------------------------------
// GEMINI API
// ---------------------------------------------------------------------------
async function extractWithGemini(conversationText, settings) {
  const model = settings.model || SettingsManager.getDefaultModel('gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}` }]
      },
      contents: [{ role: 'user', parts: [{ text: `Conversation:\n\n${conversationText}` }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: 800
      }
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n').trim();
  if (!outputText) throw new Error('Gemini returned no extractable text.');

  return normalizeResult(JSON.parse(extractJsonObject(outputText)));
}

// ---------------------------------------------------------------------------
// OPENAI
// ---------------------------------------------------------------------------
async function extractWithOpenAI(conversationText, settings) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${settings.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model || SettingsManager.getDefaultModel('openai'),
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: `Conversation:\n\n${conversationText}` }]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'cortex_extraction',
          strict: true,
          schema: MEMORY_SCHEMA
        }
      }
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.output_text || extractOpenAIOutputText(payload);
  if (!outputText) throw new Error('OpenAI returned no extractable text.');

  return normalizeResult(JSON.parse(outputText));
}

// ---------------------------------------------------------------------------
// ANTHROPIC
// ---------------------------------------------------------------------------
async function extractWithAnthropic(conversationText, settings) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model || SettingsManager.getDefaultModel('anthropic'),
      max_tokens: 800,
      system: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}`,
      messages: [{ role: 'user', content: `Conversation:\n\n${conversationText}` }]
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.content?.filter((i) => i.type === 'text').map((i) => i.text).join('\n').trim();
  if (!outputText) throw new Error('Anthropic returned no extractable text.');

  return normalizeResult(JSON.parse(extractJsonObject(outputText)));
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error?.status || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

function extractOpenAIOutputText(payload) {
  return payload.output
    ?.flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' || item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
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
        topic: String(m.topic || 'general').trim().toLowerCase() || 'general'
      }))
      .filter((m) => m.fact.length > 0)
      .slice(0, 6)
  };
}

export default Summarizer;

import SettingsManager from './settings.js';

const SYSTEM_PROMPT = `Extract durable user memories from the conversation.

Return only facts that will help future AI sessions understand the user better.
Prefer stable facts about projects, preferences, goals, workflows, constraints, people, and recurring context.
Do not store secrets, passwords, API keys, access tokens, medical details, financial account details, or one-off transient chat content.
Each fact must be a single sentence, specific, and useful without the original conversation.`;

const JSON_INSTRUCTION = `Return strict JSON only, no other text: {"memories":[{"fact":"...","topic":"..."}]}
Topic must be one of: project, preference, workflow, person, general.
Maximum 8 memories.`;

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memories: {
      type: 'array',
      maxItems: 8,
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
  required: ['memories']
};

// Gemini rejects additionalProperties; use a stripped-down version.
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      maxItems: 8,
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
  required: ['memories']
};

const Summarizer = {
  extractMemories: async (conversationText) => {
    const text = conversationText.trim();
    if (!text) throw new Error('Paste conversation text first.');

    const settings = await SettingsManager.getSettings();

    if (settings.provider === 'chrome-ai') {
      return extractWithChromeAI(text);
    }

    if (!settings.apiKey) throw new Error('Add your AI API key first.');

    if (settings.provider === 'gemini') return extractWithGemini(text, settings);
    if (settings.provider === 'anthropic') return extractWithAnthropic(text, settings);
    return extractWithOpenAI(text, settings);
  }
};

// ---------------------------------------------------------------------------
// CHROME BUILT-IN AI (free, on-device, no key needed)
// Requires Chrome Dev/Canary with chrome://flags/#prompt-api-for-gemini-nano
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

  return normalizeMemories(JSON.parse(extractJsonObject(raw)));
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

    if (availability === 'downloadable' || availability === 'downloading') {
      throw new Error('Chrome Prompt AI model is not ready yet. Open chrome://on-device-internals and wait for the model to finish downloading.');
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
      initialPrompts: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}`
        }
      ]
    });
  }

  return model.create({
    systemPrompt: `${SYSTEM_PROMPT}\n\n${JSON_INSTRUCTION}`
  });
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
      contents: [
        {
          role: 'user',
          parts: [{ text: `Conversation:\n\n${conversationText}` }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: 800
      }
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .join('\n')
    .trim();

  if (!outputText) throw new Error('Gemini returned no extractable text.');

  return normalizeMemories(JSON.parse(extractJsonObject(outputText)));
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
          name: 'cortex_memories',
          strict: true,
          schema: MEMORY_SCHEMA
        }
      }
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.output_text || extractOpenAIOutputText(payload);
  if (!outputText) throw new Error('OpenAI returned no extractable text.');

  return normalizeMemories(JSON.parse(outputText));
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
  const outputText = payload.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (!outputText) throw new Error('Anthropic returned no extractable text.');

  return normalizeMemories(JSON.parse(extractJsonObject(outputText)));
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------
async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.error?.status ||
      `${response.status} ${response.statusText}`;
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
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model did not return JSON.');
  }
  return text.slice(start, end + 1);
}

function normalizeMemories(payload) {
  const memories = Array.isArray(payload?.memories) ? payload.memories : [];
  return memories
    .map((m) => ({
      fact: String(m.fact || '').trim(),
      topic: String(m.topic || 'general').trim().toLowerCase() || 'general'
    }))
    .filter((m) => m.fact.length > 0)
    .slice(0, 8);
}

export default Summarizer;

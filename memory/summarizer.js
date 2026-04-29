import SettingsManager from './settings.js';

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
          fact: {
            type: 'string',
            description: 'A single concrete fact worth remembering.'
          },
          topic: {
            type: 'string',
            description: 'A short topic label such as project, preference, workflow, person, or general.'
          }
        },
        required: ['fact', 'topic']
      }
    }
  },
  required: ['memories']
};

const SYSTEM_PROMPT = `Extract durable user memories from the conversation.

Return only facts that will help future AI sessions understand the user better.
Prefer stable facts about projects, preferences, goals, workflows, constraints, people, and recurring context.
Do not store secrets, passwords, API keys, access tokens, medical details, financial account details, or one-off transient chat content.
Each fact must be a single sentence, specific, and useful without the original conversation.`;

const Summarizer = {
  extractMemories: async (conversationText) => {
    const text = conversationText.trim();

    if (!text) throw new Error('Paste conversation text first.');

    const settings = await SettingsManager.getSettings();

    if (!settings.apiKey) {
      throw new Error('Add your AI API key first.');
    }

    if (settings.provider === 'anthropic') {
      return extractWithAnthropic(text, settings);
    }

    return extractWithOpenAI(text, settings);
  }
};

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
          content: [
            {
              type: 'input_text',
              text: `Conversation:\n\n${conversationText}`
            }
          ]
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

  if (!outputText) {
    throw new Error('OpenAI returned no extractable text.');
  }

  return normalizeMemories(JSON.parse(outputText));
}

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
      system: `${SYSTEM_PROMPT}\n\nReturn strict JSON matching this shape: {"memories":[{"fact":"...","topic":"..."}]}`,
      messages: [
        {
          role: 'user',
          content: `Conversation:\n\n${conversationText}`
        }
      ]
    })
  });

  const payload = await parseJsonResponse(response);
  const outputText = payload.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (!outputText) {
    throw new Error('Anthropic returned no extractable text.');
  }

  return normalizeMemories(JSON.parse(extractJsonObject(outputText)));
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error?.message ||
      payload?.error ||
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
    .map((memory) => ({
      fact: String(memory.fact || '').trim(),
      topic: String(memory.topic || 'general').trim().toLowerCase() || 'general'
    }))
    .filter((memory) => memory.fact.length > 0)
    .slice(0, 8);
}

export default Summarizer;

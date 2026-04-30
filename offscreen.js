// Offscreen document - has full renderer context so Chrome Prompt AI works here.
// The background service worker messages this when Chrome AI is selected.

const SYSTEM_PROMPT = `Extract durable user memories from the conversation.

Return only facts that will help future AI sessions understand the user better.
Prefer stable facts about projects, preferences, goals, workflows, constraints, people, and recurring context.
Do not store secrets, passwords, API keys, access tokens, medical details, financial account details, or one-off transient chat content.
Each fact must be a single sentence, specific, and useful without the original conversation.`;

const JSON_INSTRUCTION = `Return strict JSON only - no other text:
{"summary":"...","memories":[{"fact":"...","topic":"...","entity":"...","category":"...","kind":"project","action":"add","target":""}]}
Topic must be one of: project, preference, workflow, person, general.
Entity is the main normalized thing this memory is about, or "" if none.
Category must be one of: project, tool, preference, workflow, constraint, person, general.
Kind must be one of: personal, project, domain, correction, rule. Use domain/correction/rule for reusable knowledge that would prevent re-explaining a concept.
Action must be add, update, or delete. Only use update/delete when the user explicitly replaces or retracts a durable fact.
Target is the old fact or entity being replaced/retired, or "" for add.`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cortex.offscreen.status') {
    getChromeAIStatus()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  if (message?.type !== 'cortex.offscreen.extract') return false;

  extractWithChromeAI(message.text)
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true;
});

async function getChromeAIStatus() {
  const model = getChromeLanguageModel();

  if (!model) {
    return {
      success: false,
      available: 'missing',
      error: 'Chrome Prompt AI API is not exposed in this browser.'
    };
  }

  const availability = await getChromeAIAvailability(model);

  if (availability === 'unavailable') {
    return {
      success: false,
      available: availability,
      error: 'Chrome Prompt AI is unavailable on this browser/device.'
    };
  }

  const probe = await probeChromeAI(model);

  if (!probe.success) {
    return {
      success: false,
      available: availability,
      error: `Chrome Prompt AI API is exposed but could not create a session. Availability: ${availability}. ${probe.error}`
    };
  }

  return {
    success: true,
    available: availability || 'available',
    probe: probe.output
  };
}

async function extractWithChromeAI(text) {
  const model = getChromeLanguageModel();

  if (!model) {
    throw new Error(
      'Chrome Prompt AI is not available. Enable the Prompt API flags, restart Chrome, or switch provider in settings.'
    );
  }

  await assertChromeAIAvailable(model);

  const session = await createChromeAISession(model);
  const raw = await session.prompt(`Conversation:\n\n${text}`);
  session.destroy?.();

  return parseMemories(raw);
}

function getChromeLanguageModel() {
  return window.LanguageModel ??
    window.ai?.languageModel ??
    window.ai?.assistant ??
    null;
}

async function assertChromeAIAvailable(model) {
  const availability = await getChromeAIAvailability(model);

  if (availability === 'unavailable') {
    throw new Error('Chrome Prompt AI is unavailable on this browser/device.');
  }
}

async function getChromeAIAvailability(model) {
  if (typeof model.availability === 'function') {
    const availability = await model.availability().catch(() => null);
    if (availability) return availability;
  }

  if (typeof model.capabilities === 'function') {
    const capabilities = await model.capabilities();

    if (capabilities?.available === 'no') return 'unavailable';
    if (capabilities?.available === 'readily') return 'available';
    if (capabilities?.available) return capabilities.available;
  }

  return 'available';
}

function createChromeAISession(model) {
  if (window.LanguageModel && model === window.LanguageModel) {
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

async function probeChromeAI(model) {
  let session;

  try {
    session = await createChromeAISession(model);
    const output = await session.prompt('Reply with only: OK');
    return { success: true, output: String(output || '').trim().slice(0, 40) };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  } finally {
    session?.destroy?.();
  }
}

function getErrorMessage(error) {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

function parseMemories(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Chrome AI did not return JSON.');
  const json = JSON.parse(raw.slice(start, end + 1));
  const summary = String(json?.summary || '').trim();
  const memories = Array.isArray(json?.memories) ? json.memories : [];
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

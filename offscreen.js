// Offscreen document - has full renderer context so Chrome Prompt AI works here.
// The background service worker messages this when Chrome AI is selected.

const SYSTEM_PROMPT = `Extract durable user memories from the conversation.

Return only facts that will help future AI sessions understand the user better.
Prefer stable facts about projects, preferences, goals, workflows, constraints, people, and recurring context.
Do not store secrets, passwords, API keys, access tokens, medical details, financial account details, or one-off transient chat content.
Each fact must be a single sentence, specific, and useful without the original conversation.`;

const JSON_INSTRUCTION = `Return strict JSON only, no other text: {"memories":[{"fact":"...","topic":"..."}]}
Topic must be one of: project, preference, workflow, person, general.
Maximum 8 memories.`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cortex.offscreen.status') {
    getChromeAIStatus()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  if (message?.type !== 'cortex.offscreen.extract') return false;

  extractWithChromeAI(message.text)
    .then((memories) => sendResponse({ success: true, memories }))
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

  if (availability === 'downloadable' || availability === 'downloading') {
    return {
      success: false,
      available: availability,
      error: 'Chrome Prompt AI model is not ready yet. Leave Chrome open and check chrome://on-device-internals.'
    };
  }

  if (availability === 'unavailable') {
    return {
      success: false,
      available: availability,
      error: 'Chrome Prompt AI is unavailable on this browser/device.'
    };
  }

  return {
    success: true,
    available: availability || 'available'
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

  if (availability === 'downloadable' || availability === 'downloading') {
    throw new Error('Chrome Prompt AI model is not ready yet. Open chrome://on-device-internals and wait for the model to finish downloading.');
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

function parseMemories(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Chrome AI did not return JSON.');
  const json = JSON.parse(raw.slice(start, end + 1));
  const memories = Array.isArray(json?.memories) ? json.memories : [];
  return memories
    .map((m) => ({
      fact: String(m.fact || '').trim(),
      topic: String(m.topic || 'general').trim().toLowerCase() || 'general'
    }))
    .filter((m) => m.fact.length > 0)
    .slice(0, 8);
}

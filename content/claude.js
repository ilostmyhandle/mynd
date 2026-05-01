import {
  startWatching,
  startNavigationWatcher,
  setupInjector,
  setContentEditable,
  collectText,
  querySelector
} from './shared.js';

console.log('mynd: Claude script loaded.');

function getConversationText() {
  const specific = [
    '.font-claude-message',
    '[data-testid="assistant-message"]',
    '[data-testid="ai-turn"]',
    '[data-testid="conversation-turn"] [class*="prose"]',
    '[data-testid*="turn"]',
    'div.whitespace-pre-wrap',
    '[class*="prose"]',
    '[class*="markdown"]',
  ];

  for (const sel of specific) {
    const text = collectText(sel);
    if (text && text.length > 50) return text;
  }

  // Broad fallback: get everything from the main conversation container
  const root = document.querySelector('main') || document.querySelector('[role="main"]');
  if (root) {
    const text = root.innerText?.trim();
    if (text && text.length > 50) return text;
  }

  return '';
}

function getInput() {
  return querySelector(
    'div[contenteditable="true"][data-placeholder]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"]'
  );
}

function getSubmit() {
  return querySelector(
    'button[aria-label="Send Message"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[data-testid="send-button"]',
    'form button[type="submit"]'
  );
}

startWatching({ platform: 'claude', getConversationText });
startNavigationWatcher({ platform: 'claude', getConversationText, getInput, getSubmit, setInput: setContentEditable });
setupInjector({ getInput, getSubmit, setInput: setContentEditable });

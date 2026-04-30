import {
  startWatching,
  startNavigationWatcher,
  setupInjector,
  setContentEditable,
  setReactTextarea,
  collectText,
  querySelector
} from './shared.js';

console.log('Cortex: ChatGPT script loaded.');

function getConversationText() {
  return collectText(
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .prose',
    '[data-message-author-role="user"] .whitespace-pre-wrap',
    '[data-message-author-role="user"]'
  ) || collectText('.markdown p', '.markdown li');
}

function getInput() {
  return querySelector(
    '#prompt-textarea',
    'div[id="prompt-textarea"]',
    'textarea[data-id="root"]',
    'div[contenteditable="true"]'
  );
}

function getSubmit() {
  return querySelector(
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]'
  );
}

function setInput(el, text) {
  if (el.tagName === 'TEXTAREA') setReactTextarea(el, text);
  else setContentEditable(el, text);
}

startWatching({ platform: 'chatgpt', getConversationText });
startNavigationWatcher({ platform: 'chatgpt', getConversationText, getInput, getSubmit, setInput });
setupInjector({ getInput, getSubmit, setInput });

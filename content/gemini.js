import {
  startWatching,
  startNavigationWatcher,
  setupInjector,
  setContentEditable,
  collectText,
  querySelector
} from './shared.js';

console.log('Cortex: Gemini script loaded.');

function getConversationText() {
  return collectText(
    'model-response .markdown',
    'model-response .response-content',
    '.response-container .markdown',
    'message-content.model-response-text',
    '.user-query-text',
    '.user-message-text',
    'user-query .query-text'
  ) || collectText('.markdown p', '.markdown');
}

function getInput() {
  const richTextarea = document.querySelector('rich-textarea');
  if (richTextarea) {
    const inner = richTextarea.querySelector('div[contenteditable="true"], .ql-editor, p');
    if (inner) return inner;
  }
  return querySelector(
    '.ql-editor',
    'div[contenteditable="true"][aria-label*="message"]',
    'div[contenteditable="true"]'
  );
}

function getSubmit() {
  return querySelector(
    'button.send-button',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'button[data-test-id="send-button"]'
  );
}

startWatching({ platform: 'gemini', getConversationText });
startNavigationWatcher({ platform: 'gemini', getConversationText, getInput, getSubmit, setInput: setContentEditable });
setupInjector({ getInput, getSubmit, setInput: setContentEditable });

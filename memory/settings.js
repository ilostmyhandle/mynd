const SETTINGS_KEY = 'mynd.aiSettings';
const LEGACY_SETTINGS_KEY = 'cortex.aiSettings';

const DEFAULT_SETTINGS = {
  provider: 'default',
  apiKey: '',
  model: ''
};

const SettingsManager = {
  getSettings: async () => {
    const result = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
    const storedSettings = result[SETTINGS_KEY] || result[LEGACY_SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...storedSettings
    };
  },

  saveSettings: async (settings) => {
    const current = await SettingsManager.getSettings();
    const provider = settings.provider || DEFAULT_SETTINGS.provider;
    const needsApiKey = provider !== 'default' && provider !== 'chrome-ai';
    const incomingKey = settings.apiKey?.trim() || '';
    const shouldReuseExistingKey = needsApiKey &&
      !incomingKey &&
      !settings.clearApiKey &&
      current.provider === provider &&
      current.apiKey;

    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      provider,
      apiKey: needsApiKey ? (shouldReuseExistingKey ? current.apiKey : incomingKey) : '',
      model: settings.model?.trim() || getDefaultModel(provider)
    };
    delete nextSettings.clearApiKey;

    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    await chrome.storage.local.remove([LEGACY_SETTINGS_KEY]);
    return nextSettings;
  },

  getDefaultModel
};

function getDefaultModel(provider) {
  if (provider === 'default') return 'gpt-4o-mini';
  if (provider === 'anthropic') return 'claude-sonnet-4-20250514';
  if (provider === 'gemini') return 'gemini-2.0-flash';
  if (provider === 'chrome-ai') return '';
  return 'gpt-4o-mini';
}

export default SettingsManager;

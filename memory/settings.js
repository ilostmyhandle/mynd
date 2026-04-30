const SETTINGS_KEY = 'cortex.aiSettings';

const DEFAULT_SETTINGS = {
  provider: 'default',
  apiKey: '',
  model: ''
};

const SettingsManager = {
  getSettings: async () => {
    const result = await chrome.storage.local.get([SETTINGS_KEY]);
    return {
      ...DEFAULT_SETTINGS,
      ...(result[SETTINGS_KEY] || {})
    };
  },

  saveSettings: async (settings) => {
    const provider = settings.provider || DEFAULT_SETTINGS.provider;
    const needsApiKey = provider !== 'default' && provider !== 'chrome-ai';

    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      provider,
      apiKey: needsApiKey ? settings.apiKey?.trim() || '' : '',
      model: settings.model?.trim() || getDefaultModel(provider)
    };

    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
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

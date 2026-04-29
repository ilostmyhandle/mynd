const SETTINGS_KEY = 'cortex.aiSettings';

const DEFAULT_SETTINGS = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4.1-mini'
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
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      apiKey: settings.apiKey?.trim() || '',
      model: settings.model?.trim() || getDefaultModel(settings.provider)
    };

    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    return nextSettings;
  },

  getDefaultModel
};

function getDefaultModel(provider) {
  if (provider === 'anthropic') return 'claude-sonnet-4-20250514';
  return 'gpt-4.1-mini';
}

export default SettingsManager;

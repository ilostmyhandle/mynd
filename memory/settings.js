const SETTINGS_KEY = 'mynd.aiSettings';
const LEGACY_SETTINGS_KEY = 'cortex.aiSettings';

const DEFAULT_SETTINGS = {
  provider: 'default',
  model: ''
};

const SettingsManager = {
  getSettings: async () => {
    const result = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
    const storedSettings = result[SETTINGS_KEY] || result[LEGACY_SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      provider: normalizeProvider(storedSettings.provider)
    };
  },

  saveSettings: async (settings) => {
    const current = await SettingsManager.getSettings();
    const provider = normalizeProvider(settings.provider || current.provider);

    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      provider,
      model: settings.model?.trim() || getDefaultModel(provider)
    };
    delete nextSettings.apiKey;
    delete nextSettings.clearApiKey;

    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    await chrome.storage.local.remove([LEGACY_SETTINGS_KEY]);
    await chrome.storage.local.remove(['openaiApiKey', 'anthropicApiKey', 'geminiApiKey']);
    return nextSettings;
  },

  getDefaultModel
};

function normalizeProvider(provider) {
  return provider === 'chrome-ai' ? 'chrome-ai' : 'default';
}

function getDefaultModel(provider) {
  if (provider === 'default') return 'gpt-4o-mini';
  if (provider === 'chrome-ai') return '';
  return 'gpt-4o-mini';
}

export default SettingsManager;

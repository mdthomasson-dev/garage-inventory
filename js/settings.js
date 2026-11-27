const KEY = 'garage-inventory-settings';

export const DEFAULT_MODEL = 'gemini-flash-latest';

const defaults = { apiKey: '', model: DEFAULT_MODEL, autoIdentify: true };

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode etc. — settings just won't persist */
  }
}

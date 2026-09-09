import { translations, type Lang } from './lang';
export type { Lang };

const STORAGE_KEY = 'screenmirror_lang';

let currentLang: Lang = (localStorage.getItem(STORAGE_KEY) as Lang | null) ?? 'tr';

export function t(key: string): string {
  return translations[currentLang][key] ?? translations['en'][key] ?? key;
}

export function getLang(): Lang { return currentLang; }

export function setLang(lang: Lang) {
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  applyTranslations();
  window.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
}

/** Walk the DOM and replace all [data-i18n] text / attributes. */
export function applyTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n')!);
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder')!);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title')!);
  });
}

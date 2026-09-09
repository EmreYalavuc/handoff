import { getLang, setLang, applyTranslations, type Lang } from '../i18n';

/** Creates a fixed-position 🇹🇷/🇬🇧 flag switcher and appends it to document.body. */
export function initLangSwitcher() {
  const div = document.createElement('div');
  div.className = 'lang-switcher';
  div.innerHTML = `
    <button class="lang-btn" data-lang="tr" title="Türkçe">🇹🇷 TR</button>
    <button class="lang-btn" data-lang="en" title="English">🇬🇧 EN</button>
  `;
  document.body.appendChild(div);

  syncActive(div);

  div.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setLang(btn.dataset['lang'] as Lang);
      syncActive(div);
    });
  });

  // Apply translations immediately (TR is default)
  applyTranslations();
  document.documentElement.lang = getLang();
}

function syncActive(container: HTMLElement) {
  const lang = getLang();
  container.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('lang-btn--active', btn.getAttribute('data-lang') === lang);
  });
}

'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { translateMiroFish, type MiroFishLocale } from '@/lib/mirofish/i18n/messages';

const LocaleContext = createContext({ locale: 'zh' as MiroFishLocale,
  setLocale: (locale: MiroFishLocale) => { void locale; }, t: (zh: string, en?: string) => { void en; return zh; } });
let memoryLocale: MiroFishLocale = 'zh';
const readLocale = (): MiroFishLocale => {
  try { return localStorage.getItem('mirofish.locale') === 'en' ? 'en' : 'zh'; } catch { return memoryLocale; }
};
const subscribe = (notify: () => void) => {
  window.addEventListener('mirofish-locale', notify); window.addEventListener('storage', notify);
  return () => { window.removeEventListener('mirofish-locale', notify); window.removeEventListener('storage', notify); };
};
function chooseLocale(locale: MiroFishLocale) {
  memoryLocale = locale;
  try { localStorage.setItem('mirofish.locale', locale); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new window.Event('mirofish-locale'));
}

export function MiroFishLocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribe, readLocale, () => 'zh' as const);
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);
  const t = useCallback((zh: string, en?: string) => translateMiroFish(locale, zh, en), [locale]);
  const value = useMemo(() => ({ locale, setLocale: chooseLocale, t }), [locale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useMiroFishLocale() { return useContext(LocaleContext); }

export function MiroFishLanguageSwitcher() {
  const { locale, setLocale, t } = useMiroFishLocale();
  return <label className="flex items-center gap-2 text-xs text-slate-300">
    <span>{t('语言', 'Language')}</span>
    <select aria-label={t('语言', 'Language')} value={locale} onChange={event => setLocale(event.target.value === 'en' ? 'en' : 'zh')}
      className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 text-white">
      <option value="zh">中文</option><option value="en">English</option>
    </select>
  </label>;
}

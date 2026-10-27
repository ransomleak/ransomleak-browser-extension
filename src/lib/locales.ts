// Supported UI locales. Kept separate from i18n.ts so the background worker does not bundle the string tables.
export type Locale = 'en' | 'de' | 'fr' | 'it' | 'nl' | 'uk';
export const LOCALES: readonly Locale[] = ['en', 'de', 'fr', 'it', 'nl', 'uk'];
export const isSupportedLocale = (l: unknown): l is Locale => typeof l === 'string' && (LOCALES as readonly string[]).includes(l);

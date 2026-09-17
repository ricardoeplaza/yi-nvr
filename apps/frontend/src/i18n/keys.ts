// i18n key manifest. Spanish is the source language (es.json); every other
// locale is a sibling flat JSON file with the same keys and order.
import es from './es.json';

export type I18nKey = keyof typeof es;
export const I18N_KEYS: Readonly<Record<I18nKey, string>> = es;

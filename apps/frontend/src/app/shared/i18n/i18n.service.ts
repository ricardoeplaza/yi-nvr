import { Injectable } from '@angular/core';
import { I18N_KEYS, type I18nKey } from '../../../i18n/keys';
import esMessages from '../../../i18n/es.json';
import enMessages from '../../../i18n/en.json';
import frMessages from '../../../i18n/fr.json';
import deMessages from '../../../i18n/de.json';
import ptMessages from '../../../i18n/pt.json';
import itMessages from '../../../i18n/it.json';

/** Locales the app supports. Product decision: these 6, even though only
 *  es/en JSON files exist so far (fr/de/pt/it land in later commits). */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'it'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// One entry per locale file. When a new locale JSON lands, add its import + line here.
const MESSAGES: Partial<Record<Locale, Record<string, string>>> = {
  es: esMessages,
  en: enMessages,
  fr: frMessages,
  de: deMessages,
  pt: ptMessages,
  it: itMessages,
};

/**
 * Minimal i18n: the locale is detected once at bootstrap from the browser
 * locale and lives in memory (no switching, no persistence).
 *
 * English is the universal default: an unsupported browser locale resolves to
 * 'en'. Spanish (es.json) is the source language and the guaranteed last
 * fallback inside t(), so output is never broken.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  /** Detected locale ('en' when the browser locale is unsupported). */
  readonly lang: Locale;

  constructor() {
    const raw = (navigator.languages?.[0] ?? navigator.language).toLowerCase();
    const prefix = raw.split('-')[0];
    this.lang = (SUPPORTED_LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : 'en';
    document.documentElement.lang = this.lang;
  }

  /**
   * Translates a key, substituting {{param}} placeholders.
   * Uses the detected locale's template when present and non-empty, otherwise
   * falls back to Spanish (es.json — source language, always complete).
   */
  t(key: I18nKey, params?: Record<string, string | number>): string {
    let template = MESSAGES[this.lang]?.[key];
    if (typeof template !== 'string' || template.length === 0) {
      template = MESSAGES.es?.[key] ?? '';
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''));
  }

  /**
   * Translates an API error. The API returns
   * `{ success: false, code: 'VIDEO_NOT_FOUND', error: 'Video no encontrado' }`,
   * which HttpClient delivers as `err.error`.
   *
   * Resolution order:
   * 1. If `err.error.code` exists and `errors.<code lowercased>` is a known key
   *    in I18N_KEYS → t(key).
   * 2. Otherwise the raw string: `err.error` when it is a string (or the
   *    server's own `error` text inside the body), then `err.message`, then
   *    String(err). keys.ts has no generic unknown-error key, so unknown
   *    errors are shown as-is.
   */
  translateApiError(err: unknown): string {
    const e = err as { error?: unknown; message?: unknown } | null | undefined;
    const body = e?.error;

    if (body !== null && typeof body === 'object') {
      const code = (body as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) {
        const key = `errors.${code.toLowerCase()}` as I18nKey;
        if (key in I18N_KEYS) {
          return this.t(key);
        }
      }
    }

    if (typeof body === 'string' && body.length > 0) {
      return body;
    }
    const inner =
      body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    if (typeof inner === 'string' && inner.length > 0) {
      return inner;
    }
    const message = e?.message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
    return String(err);
  }
}

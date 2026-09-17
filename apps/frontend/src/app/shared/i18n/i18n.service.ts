import { Injectable } from '@angular/core';
import { I18N_KEYS, type I18nKey } from '../../../i18n/keys';
import enMessages from '../../../i18n/en.json';

/** English templates (en.json). Keys missing here fall back to Spanish. */
const EN_MESSAGES: Record<string, string> = enMessages;

/**
 * Minimal i18n: the language is detected once at bootstrap from the browser
 * locale and lives in memory (no switching, no persistence).
 *
 * Spanish templates are the base (I18N_KEYS); English comes from en.json.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  /** Detected language: 'en' if the browser locale starts with 'en', else 'es'. */
  readonly lang: 'es' | 'en';

  constructor() {
    const locale = (navigator.languages?.[0] ?? navigator.language).toLowerCase();
    this.lang = locale.startsWith('en') ? 'en' : 'es';
    document.documentElement.lang = this.lang;
  }

  /**
   * Translates a key, substituting {{param}} placeholders.
   * Spanish (I18N_KEYS) is the base; in English the en.json entry is used
   * when present, otherwise it falls back to Spanish.
   */
  t(key: I18nKey, params?: Record<string, string | number>): string {
    let template: string = I18N_KEYS[key];
    if (this.lang === 'en') {
      const en = EN_MESSAGES[key];
      if (typeof en === 'string' && en.length > 0) {
        template = en;
      }
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

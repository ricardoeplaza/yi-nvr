import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from './i18n/i18n.service';

@Pipe({ name: 'formatDate', standalone: true })
export class FormatDatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(value: string | null | undefined): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return '';
    }
    const locale = this.i18n.lang === 'en' ? 'en-US' : 'es-ES';
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (isSameDay(date, now)) {
      return hm;
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isSameDay(date, yesterday)) {
      return `${this.i18n.t('gallery.day.yesterday')} ${hm}`;
    }
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (date >= weekAgo) {
      const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
      return `${weekday} ${hm}`;
    }
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${hm}`;
  }
}

import { Pipe, PipeTransform } from '@angular/core';

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

@Pipe({ name: 'formatDate', standalone: true })
export class FormatDatePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return '';
    }
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
      return `Ayer ${hm}`;
    }
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    if (date >= weekAgo) {
      return `${DAYS[date.getDay()]} ${hm}`;
    }
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${hm}`;
  }
}

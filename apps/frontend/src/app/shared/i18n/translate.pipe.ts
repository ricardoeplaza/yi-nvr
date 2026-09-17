import { Pipe, PipeTransform, inject } from '@angular/core';
import type { I18nKey } from '../../../i18n/keys';
import { I18nService } from './i18n.service';

/** Usage: {{ 'some.key' | t: { count: n } }} */
@Pipe({ name: 't', standalone: true, pure: true })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: I18nKey, params?: Record<string, string | number>): string {
    return this.i18n.t(key, params);
  }
}

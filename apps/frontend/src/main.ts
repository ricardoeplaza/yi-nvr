import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { I18nService } from './app/shared/i18n/i18n.service';

bootstrapApplication(App, appConfig)
  .then((m) => m.injector.get(I18nService))
  .catch((err) => console.error(err));

import { Component, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PushService } from '../../services/push.service';
import { AppHeader } from '../../shared/app-header/app-header';
import { I18nService } from '../../shared/i18n/i18n.service';
import { TranslatePipe } from '../../shared/i18n/translate.pipe';

type PushStatus = 'inactive' | 'active' | 'error' | 'loading';

@Component({
  selector: 'yi-settings-page',
  standalone: true,
  imports: [AppHeader, TranslatePipe],
  template: `
    <div class="settings">
      <yi-app-header [title]="'settings.title' | t" />

      <section class="settings-section">
        <h2>{{ 'settings.notifications' | t }}</h2>
        <div class="push-card">
          <div class="push-info">
            <span class="push-title">{{ 'settings.push.title' | t }}</span>
            <span class="push-desc">{{ 'settings.push.description' | t }}</span>
          </div>
          <div class="push-action">
            @if (pushStatus() === 'active') {
              <span class="push-status active">{{ 'settings.push.statusActive' | t }}</span>
              <button class="btn btn-outline" (click)="deactivatePush()">{{ 'settings.push.disable' | t }}</button>
            } @else if (pushStatus() === 'loading') {
              <span class="push-status">{{ 'settings.push.enabling' | t }}</span>
            } @else if (pushStatus() === 'error') {
              <span class="push-status error">{{ 'settings.push.statusError' | t }}</span>
              @if (pushError() !== '') {
                <span class="push-error">{{ pushError() }}</span>
              }
              <button class="btn btn-primary" (click)="activatePush()">{{ 'common.retry' | t }}</button>
            } @else {
              <span class="push-status">{{ 'settings.push.statusInactive' | t }}</span>
              <button class="btn btn-primary" (click)="activatePush()">{{ 'settings.push.enable' | t }}</button>
            }
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>{{ 'settings.about' | t }}</h2>
        <div class="about-card">
          <div class="about-row"><span>{{ 'settings.about.application' | t }}</span><span>Yi NVR</span></div>
          <div class="about-row"><span>{{ 'settings.about.version' | t }}</span><span>1.0.0</span></div>
          <div class="about-row"><span>{{ 'settings.about.technology' | t }}</span><span>Angular PWA</span></div>
        </div>
      </section>

      <section class="settings-section">
        <h2>{{ 'settings.session' | t }}</h2>
        <div class="about-card">
          <button class="btn btn-danger full-width" (click)="logout()">{{ 'settings.session.signOut' | t }}</button>
        </div>
      </section>
    </div>
  `,
  styleUrl: './settings.page.scss'
})
export class SettingsPage implements OnInit {
  private pushService = inject(PushService);
  private i18n = inject(I18nService);

  pushStatus = signal<PushStatus>('inactive');
  pushError = signal('');

  async ngOnInit() {
    const reg = await navigator.serviceWorker.getRegistration('/push/');
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        this.pushStatus.set('active');
        return;
      }
    }
    this.pushStatus.set('inactive');
  }

  async activatePush() {
    this.pushStatus.set('loading');
    this.pushError.set('');
    try {
      const result = await this.pushService.registerPush();
      if (result.ok) {
        this.pushStatus.set('active');
      } else {
        this.pushError.set(this.errorFor(result.reason));
        this.pushStatus.set('error');
      }
    } catch {
      this.pushError.set(this.i18n.t('settings.push.errorSubscription'));
      this.pushStatus.set('error');
    }
  }

  private errorFor(reason: string): string {
    switch (reason) {
      case 'permission-denied': return this.i18n.t('settings.push.errorPermission');
      case 'no-vapid-key': return this.i18n.t('settings.push.errorNoVapidKey');
      case 'sw-registration': return this.i18n.t('settings.push.errorServiceWorker');
      case 'subscription': return this.i18n.t('settings.push.errorSubscription');
      default: return this.i18n.t('common.errorUnknown');
    }
  }

  async deactivatePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/push/');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await firstValueFrom(this.pushService.unsubscribe(sub));
          await sub.unsubscribe();
        }
      }
      this.pushStatus.set('inactive');
    } catch {
      this.pushStatus.set('inactive');
    }
  }

  logout() {
    localStorage.removeItem('yi-nvr-auth');
    window.location.href = '/login';
  }
}

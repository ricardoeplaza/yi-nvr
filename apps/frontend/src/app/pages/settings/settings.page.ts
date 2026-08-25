import { Component, inject, OnInit, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PushService } from '../../services/push.service';

type PushStatus = 'inactive' | 'active' | 'error' | 'loading';

@Component({
  selector: 'yi-settings-page',
  standalone: true,
  template: `
    <div class="settings">
      <header class="settings-header">
        <h1>Ajustes</h1>
      </header>

      <section class="settings-section">
        <h2>Notificaciones</h2>
        <div class="push-card">
          <div class="push-info">
            <span class="push-title">Notificaciones push</span>
            <span class="push-desc">Recibe alertas de movimiento en tu dispositivo</span>
          </div>
          <div class="push-action">
            @if (pushStatus() === 'active') {
              <span class="push-status active">Activadas</span>
              <button class="btn btn-outline" (click)="deactivatePush()">Desactivar</button>
            } @else if (pushStatus() === 'loading') {
              <span class="push-status">Activando…</span>
            } @else if (pushStatus() === 'error') {
              <span class="push-status error">Error</span>
              @if (pushError() !== '') {
                <span class="push-error">{{ pushError() }}</span>
              }
              <button class="btn btn-primary" (click)="activatePush()">Reintentar</button>
            } @else {
              <span class="push-status">No activadas</span>
              <button class="btn btn-primary" (click)="activatePush()">Activar</button>
            }
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Acerca de</h2>
        <div class="about-card">
          <div class="about-row"><span>Aplicación</span><span>Yi NVR</span></div>
          <div class="about-row"><span>Versión</span><span>1.0.0</span></div>
          <div class="about-row"><span>Tecnología</span><span>Angular PWA</span></div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Sesión</h2>
        <div class="about-card">
          <button class="btn btn-danger full-width" (click)="logout()">Cerrar sesión</button>
        </div>
      </section>
    </div>
  `,
  styleUrl: './settings.page.scss'
})
export class SettingsPage implements OnInit {
  private pushService = inject(PushService);

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
      this.pushError.set('No se pudo completar la suscripción');
      this.pushStatus.set('error');
    }
  }

  private errorFor(reason: string): string {
    switch (reason) {
      case 'permission-denied': return 'Permiso de notificaciones denegado';
      case 'no-vapid-key': return 'El servidor no expone la clave VAPID';
      case 'sw-registration': return 'No se pudo registrar el service worker';
      case 'subscription': return 'No se pudo completar la suscripción';
      default: return 'Error desconocido';
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

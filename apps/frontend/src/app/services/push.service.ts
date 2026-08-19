import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly http = inject(HttpClient);

  getVapidKey(): Observable<{ success: boolean; publicKey: string | null }> {
    return this.http.get<{ success: boolean; publicKey: string | null }>(
      '/api/push/vapid-public-key'
    );
  }

  subscribe(subscription: PushSubscription): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>('/api/push/subscribe', subscription);
  }

  unsubscribe(subscription: PushSubscription): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>('/api/push/unsubscribe', subscription);
  }

  async registerPush(): Promise<void> {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.error('Notification permission denied');
        return;
      }

      const registration = await navigator.serviceWorker.register('/push/sw.js', {
        scope: '/push/',
      });

      const keyResponse = await firstValueFrom(this.getVapidKey());
      if (!keyResponse.success || !keyResponse.publicKey) {
        console.error('No VAPID public key available');
        return;
      }

      const applicationServerKey = urlBase64ToUint8Array(keyResponse.publicKey);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      await firstValueFrom(this.subscribe(subscription));
    } catch (error) {
      console.error('Push registration failed', error);
    }
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

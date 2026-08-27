import { Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Camera, CameraStatus } from '../../models/camera.model';
import { FormatDatePipe } from '../format-date.pipe';

@Component({
  selector: 'yi-camera-card',
  standalone: true,
  imports: [RouterLink, FormatDatePipe],
  template: `
    <article class="camera-card">
      <a class="camera-thumb" routerLink="/cameras/{{ camera().id }}">
        @if (thumbnailUrl()) {
          <img [src]="thumbnailUrl()!" alt="" loading="lazy" [class.desaturated]="disconnected()" />
        } @else {
          <span class="camera-icon">📷</span>
        }
        <div class="thumb-vignette"></div>
        @if (isYiHack() && lastEventAt()) {
          <span class="osd-chip">{{ lastEventAt() | formatDate }}</span>
        }
        @if (isYiHack() && statusPill()) {
          <span class="state-pill" [class]="statusPill()!.cls">
            <span class="state-dot"></span>
            {{ statusPill()!.label }}
          </span>
        }
      </a>
      <div class="camera-meta">
        <div class="meta-row">
          <span class="camera-name">{{ camera().name }}</span>
          <span class="eco-badge" [class.generic]="camera().ecosystem !== 'yi-hack'">{{
            ecoLabel()
          }}</span>
        </div>
        @if (isYiHack()) {
          <div class="meta-row meta-row-2">
            <span class="camera-count">{{ camera().video_count }} videos</span>
            <span class="sep">·</span>
            @if (lastEventAt()) {
              <span class="camera-last">{{ lastEventAt() | formatDate }}</span>
            } @else {
              <span class="camera-last">Sin grabaciones</span>
            }
            @if (camera().capabilities.power) {
              <button
                class="power-toggle"
                [class.active]="powerOn() === true"
                type="button"
                (click)="$event.stopPropagation(); togglePower.emit(camera())"
              >
                <span>Encendido</span>
                <span class="power-state">{{ powerOn() ? 'ON' : 'OFF' }}</span>
              </button>
            }
          </div>
        }
      </div>
    </article>
  `,
  styleUrl: './camera-card.scss',
})
export class CameraCard {
  /* ---------- inputs ---------- */
  readonly camera = input.required<Camera>();
  readonly status = input<CameraStatus | null>(null);
  readonly powerOn = input<boolean | null>(null);
  readonly thumbnailUrl = input<string | null>(null);
  readonly lastEventAt = input<string | null>(null);

  /* ---------- outputs ---------- */
  readonly togglePower = output<Camera>();

  /* ---------- derivados ---------- */
  readonly isYiHack = computed(() => this.camera().ecosystem === 'yi-hack');

  // La imagen se desatura cuando la cámara está apagada, inaccesible o su
  // httpd no responde (puede estar viva por MQTT pero sin CGIs).
  readonly disconnected = computed(() => {
    const s = this.status();
    return !!s && (s.state === 'off' || s.state === 'unreachable' || s.http === false);
  });

  readonly statusPill = computed<{ label: string; cls: string } | null>(() => {
    const s = this.status();
    if (!s || !s.state) return null;
    if (s.state === 'on' && s.http !== false) return { label: 'En línea', cls: 'online' };
    if (s.state === 'off') return { label: 'Apagada', cls: 'off' };
    if (s.state === 'unreachable') return { label: 'Sin conexión', cls: 'unreachable' };
    return null;
  });

  ecoLabel(): string {
    switch (this.camera().ecosystem) {
      case 'yi-hack':
        return 'yi-hack';
      case 'generic':
        return 'genérica';
      default:
        return this.camera().ecosystem;
    }
  }
}

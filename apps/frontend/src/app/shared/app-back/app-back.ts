import { Component, inject, input } from '@angular/core';
import { AppNavService } from '../app-nav/app-nav.service';

@Component({
  selector: 'yi-app-back',
  standalone: true,
  template: `
    <button type="button" class="app-back" (click)="onBack()" aria-label="Volver">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
  `,
  styles: `
    :host {
      position: absolute;
      top: calc(env(safe-area-inset-top, 0px) + 10px);
      left: 12px;
      z-index: 40;
      pointer-events: none;
    }

    .app-back {
      pointer-events: auto;
      width: 38px;
      height: 38px;
      flex-shrink: 0;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
      color: #fff;
      border: none;
      padding: 0;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s var(--ease-spring);

      svg {
        width: 22px;
        height: 22px;
      }

      &:active {
        background: rgba(0, 0, 0, 0.5);
        transform: scale(0.9);
      }
    }
  `
})
export class AppBack {
  // Ruta del nivel padre al que vuelve la flecha.
  readonly to = input.required<string[]>();

  private nav = inject(AppNavService);

  onBack() {
    this.nav.goBack(this.to());
  }
}

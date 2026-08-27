import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastState {
  message: string;
  type: ToastType;
}

const TOAST_DURATION_MS = 2200;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly state = signal<ToastState | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  show(message: string, type: ToastType = 'info'): void {
    if (this.timer) clearTimeout(this.timer);
    this.state.set({ message, type });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.state.set(null);
    }, TOAST_DURATION_MS);
  }

  hide(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.set(null);
  }
}

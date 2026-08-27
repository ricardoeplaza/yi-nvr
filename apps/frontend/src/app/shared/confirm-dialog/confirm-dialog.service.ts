import { Injectable, signal } from '@angular/core';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  readonly state = signal<ConfirmDialogOptions | null>(null);
  private pendingResolve: ((value: boolean) => void) | null = null;

  show(options: ConfirmDialogOptions): Promise<boolean> {
    if (this.pendingResolve) this.pendingResolve(false);
    return new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      this.state.set(options);
    });
  }

  resolve(value: boolean): void {
    this.state.set(null);
    const r = this.pendingResolve;
    this.pendingResolve = null;
    r?.(value);
  }
}

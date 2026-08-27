import { Component, HostListener, inject } from '@angular/core';
import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'yi-confirm-dialog',
  template: `
    <div class="confirm-backdrop" [class.show]="options() !== null" (click)="onBackdropClick($event)">
      <div class="confirm-box" [class.danger]="options()?.danger === true">
        <div class="confirm-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </div>
        <h3>{{ options()?.title }}</h3>
        <p>{{ options()?.message }}</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel" (click)="onCancel()">{{ cancelLabel() }}</button>
          <button type="button" class="confirm-ok" (click)="onConfirm()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './confirm-dialog.scss',
})
export class ConfirmDialog {
  private readonly service = inject(ConfirmDialogService);

  protected readonly options = this.service.state;
  protected readonly confirmLabel = () => this.options()?.confirmLabel || 'Confirmar';
  protected readonly cancelLabel = () => this.options()?.cancelLabel || 'Cancelar';

  protected onConfirm(): void {
    this.service.resolve(true);
  }

  protected onCancel(): void {
    this.service.resolve(false);
  }

  protected onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.service.resolve(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.options()) this.service.resolve(false);
  }
}

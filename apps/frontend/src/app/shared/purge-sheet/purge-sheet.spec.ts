import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PurgeSheet, PurgeScope } from './purge-sheet';

@Component({
  imports: [PurgeSheet],
  template: `
    <yi-purge-sheet
      [open]="open()"
      [scope]="scope()"
      [expected]="expected()"
      [purging]="purging()"
      [usedLabel]="usedLabel()"
      [storageCount]="storageCount()"
      (scopeChange)="onScopeChange($event)"
      (purge)="onPurge()"
      (close)="onClose()"
    />
  `,
})
class HostComponent {
  open = signal(false);
  scope = signal<PurgeScope>('month');
  expected = signal<number | null>(null);
  purging = signal(false);
  usedLabel = signal('5 MB');
  storageCount = signal<number | null>(null);
  onScopeChange = vi.fn();
  onPurge = vi.fn();
  onClose = vi.fn();
}

describe('PurgeSheet', () => {
  async function createHost() {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('open aplica la clase .show al backdrop y a la hoja', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const backdrop = () => fixture.nativeElement.querySelector('.sheet-backdrop') as HTMLElement;
    const sheet = () => fixture.nativeElement.querySelector('.sheet') as HTMLElement;
    expect(backdrop().classList.contains('show')).toBe(false);
    expect(sheet().classList.contains('show')).toBe(false);
    host.open.set(true);
    fixture.detectChanges();
    expect(backdrop().classList.contains('show')).toBe(true);
    expect(sheet().classList.contains('show')).toBe(true);
    fixture.destroy();
  });

  it('muestra los 4 scopes y marca el seleccionado', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const buttons = fixture.nativeElement.querySelectorAll('.segmented button') as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(4);
    expect(buttons[2].classList.contains('is-selected')).toBe(true); // default 'month'
    host.scope.set('all');
    fixture.detectChanges();
    expect(buttons[3].classList.contains('is-selected')).toBe(true);
    expect(buttons[2].classList.contains('is-selected')).toBe(false);
    fixture.destroy();
  });

  it('clic en un scope emite scopeChange', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const buttons = fixture.nativeElement.querySelectorAll('.segmented button') as NodeListOf<HTMLButtonElement>;
    buttons[0].click();
    expect(host.onScopeChange).toHaveBeenCalledWith('day');
    buttons[3].click();
    expect(host.onScopeChange).toHaveBeenCalledWith('all');
    fixture.destroy();
  });

  it('muestra expected o "…" y las filas de almacenamiento', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const preview = () => fixture.nativeElement.querySelector('.purge-preview b') as HTMLElement;
    expect(preview().textContent).toBe('…');
    host.expected.set(12);
    host.storageCount.set(340);
    fixture.detectChanges();
    expect(preview().textContent).toBe('12');
    const values = Array.from(fixture.nativeElement.querySelectorAll('.sheet-row .value')).map(
      (el) => (el as HTMLElement).textContent
    );
    expect(values).toEqual(['5 MB', '340']);
    fixture.destroy();
  });

  it('el botón purge está deshabilitado con expected 0/null y emite purge', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const btn = () => fixture.nativeElement.querySelector('.purge-btn') as HTMLButtonElement;
    expect(btn().disabled).toBe(true); // expected null
    host.expected.set(0);
    fixture.detectChanges();
    expect(btn().disabled).toBe(true);
    host.expected.set(3);
    fixture.detectChanges();
    expect(btn().disabled).toBe(false);
    btn().click();
    expect(host.onPurge).toHaveBeenCalled();
    fixture.destroy();
  });

  it('purging=true deshabilita el botón y cambia la etiqueta', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.expected.set(3);
    host.purging.set(true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.purge-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Borrando…');
    fixture.destroy();
  });

  it('el click en el backdrop emite close', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    (fixture.nativeElement.querySelector('.sheet-backdrop') as HTMLElement).click();
    expect(host.onClose).toHaveBeenCalled();
    fixture.destroy();
  });
});

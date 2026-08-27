import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { SelectionBar } from './selection-bar';

@Component({
  imports: [SelectionBar],
  template: `
    <yi-selection-bar [show]="show()" [count]="count()" (favorite)="onFavorite()" (remove)="onRemove()" />
  `,
})
class HostComponent {
  show = signal(false);
  count = signal(0);
  onFavorite = vi.fn();
  onRemove = vi.fn();
}

describe('SelectionBar', () => {
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

  it('show aplica la clase .show', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const bar = () => fixture.nativeElement.querySelector('.selection-bar') as HTMLElement;
    expect(bar().classList.contains('show')).toBe(false);
    host.show.set(true);
    fixture.detectChanges();
    expect(bar().classList.contains('show')).toBe(true);
    fixture.destroy();
  });

  it('muestra el conteo en singular y plural', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const count = () => fixture.nativeElement.querySelector('.sel-count') as HTMLElement;
    host.count.set(1);
    fixture.detectChanges();
    expect(count().textContent).toContain('1 seleccionado');
    host.count.set(2);
    fixture.detectChanges();
    expect(count().textContent).toContain('2 seleccionados');
    fixture.destroy();
  });

  it('los botones están deshabilitados con count 0 y emiten sus outputs', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const fav = () => fixture.nativeElement.querySelector('.sel-btn') as HTMLButtonElement;
    const del = () => fixture.nativeElement.querySelector('.sel-btn.danger') as HTMLButtonElement;
    expect(fav().disabled).toBe(true);
    expect(del().disabled).toBe(true);
    host.count.set(2);
    fixture.detectChanges();
    expect(fav().disabled).toBe(false);
    expect(del().disabled).toBe(false);
    fav().click();
    del().click();
    expect(host.onFavorite).toHaveBeenCalled();
    expect(host.onRemove).toHaveBeenCalled();
    fixture.destroy();
  });
});

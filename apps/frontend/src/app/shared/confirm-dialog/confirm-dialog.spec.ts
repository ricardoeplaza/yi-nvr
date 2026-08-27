import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConfirmDialog } from './confirm-dialog';
import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialog', () => {
  let component: ConfirmDialog;
  let fixture: ComponentFixture<ConfirmDialog>;
  let host: HTMLElement;
  let service: ConfirmDialogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialog],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialog);
    component = fixture.componentInstance;
    host = fixture.nativeElement;
    service = TestBed.inject(ConfirmDialogService);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function open(): Promise<boolean> {
    return service.show({
      title: 'Eliminar clip',
      message: 'Esta acción no se puede deshacer.',
    });
  }

  function backdrop(): HTMLElement {
    return host.querySelector('.confirm-backdrop') as HTMLElement;
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('arranca oculto', () => {
    expect(backdrop().classList.contains('show')).toBe(false);
  });

  it('muestra título, mensaje y etiquetas por defecto al abrirse', () => {
    open();
    fixture.detectChanges();
    expect(backdrop().classList.contains('show')).toBe(true);
    expect(host.querySelector('.confirm-box h3')?.textContent).toBe('Eliminar clip');
    expect(host.querySelector('.confirm-box p')?.textContent).toContain('no se puede deshacer');
    expect(host.querySelector('.confirm-ok')?.textContent).toBe('Confirmar');
    expect(host.querySelector('.confirm-cancel')?.textContent).toBe('Cancelar');
  });

  it('usa las etiquetas personalizadas y la clase danger', () => {
    service.show({
      title: 'Eliminar',
      message: '¿Seguro?',
      confirmLabel: 'Eliminar',
      cancelLabel: 'Volver',
      danger: true,
    });
    fixture.detectChanges();
    expect(host.querySelector('.confirm-ok')?.textContent).toBe('Eliminar');
    expect(host.querySelector('.confirm-cancel')?.textContent).toBe('Volver');
    expect(host.querySelector('.confirm-box')?.classList.contains('danger')).toBe(true);
  });

  it('el botón confirmar resuelve true y cierra', async () => {
    const promise = open();
    fixture.detectChanges();
    (host.querySelector('.confirm-ok') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(promise).resolves.toBe(true);
    expect(service.state()).toBeNull();
  });

  it('el botón cancelar resuelve false y cierra', async () => {
    const promise = open();
    fixture.detectChanges();
    (host.querySelector('.confirm-cancel') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(promise).resolves.toBe(false);
    expect(service.state()).toBeNull();
  });

  it('un click en el backdrop resuelve false', async () => {
    const promise = open();
    fixture.detectChanges();
    backdrop().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(promise).resolves.toBe(false);
    expect(service.state()).toBeNull();
  });

  it('un click dentro de la caja NO cierra el diálogo', async () => {
    const promise = open();
    fixture.detectChanges();
    const box = host.querySelector('.confirm-box') as HTMLElement;
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    let resolved: boolean | undefined;
    promise.then((v) => (resolved = v));
    expect(resolved).toBeUndefined();
    expect(service.state()).not.toBeNull();
  });

  it('la tecla Escape resuelve false', async () => {
    const promise = open();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(promise).resolves.toBe(false);
    expect(service.state()).toBeNull();
  });

  it('Escape sin diálogo abierto no hace nada', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.state()).toBeNull();
  });
});

import { TestBed } from '@angular/core/testing';

import { ConfirmDialogService, ConfirmDialogOptions } from './confirm-dialog.service';

describe('ConfirmDialogService', () => {
  let service: ConfirmDialogService;

  const options: ConfirmDialogOptions = { title: 'Eliminar clip', message: 'Esta acción no se puede deshacer.' };

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConfirmDialogService);
  });

  it('should create', () => {
    expect(service).toBeTruthy();
  });

  it('show() activa el estado y devuelve una promesa pendiente', () => {
    const promise = service.show(options);
    expect(service.state()).toEqual(options);
    let resolved: boolean | undefined;
    promise.then((v) => (resolved = v));
    expect(resolved).toBeUndefined();
  });

  it('resolve(true) resuelve la promesa con true y cierra el diálogo', async () => {
    const promise = service.show(options);
    service.resolve(true);
    await expect(promise).resolves.toBe(true);
    expect(service.state()).toBeNull();
  });

  it('resolve(false) resuelve la promesa con false y cierra el diálogo', async () => {
    const promise = service.show(options);
    service.resolve(false);
    await expect(promise).resolves.toBe(false);
    expect(service.state()).toBeNull();
  });

  it('un segundo show() resuelve el primero con false y abre el nuevo', async () => {
    const first = service.show({ title: 'Primero', message: 'a' });
    const second = service.show({ title: 'Segundo', message: 'b' });
    await expect(first).resolves.toBe(false);
    expect(service.state()).toEqual({ title: 'Segundo', message: 'b' });
    service.resolve(true);
    await expect(second).resolves.toBe(true);
    expect(service.state()).toBeNull();
  });
});

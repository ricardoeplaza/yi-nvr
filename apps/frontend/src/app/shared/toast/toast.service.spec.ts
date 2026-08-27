import { TestBed } from '@angular/core/testing';

import { ToastService } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create', () => {
    expect(service).toBeTruthy();
  });

  it('show() activa el estado con el mensaje y el tipo', () => {
    service.show('Clip eliminado', 'success');
    expect(service.state()).toEqual({ message: 'Clip eliminado', type: 'success' });
  });

  it('el tipo por defecto es info', () => {
    service.show('Hola');
    expect(service.state()).toEqual({ message: 'Hola', type: 'info' });
  });

  it('se auto-oculta a los 2200 ms', () => {
    service.show('Hola');
    expect(service.state()).not.toBeNull();
    vi.advanceTimersByTime(2199);
    expect(service.state()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(service.state()).toBeNull();
  });

  it('un nuevo show() reinicia el temporizador', () => {
    service.show('uno');
    vi.advanceTimersByTime(2000);
    service.show('dos');
    vi.advanceTimersByTime(2199);
    expect(service.state()).toEqual({ message: 'dos', type: 'info' });
    vi.advanceTimersByTime(1);
    expect(service.state()).toBeNull();
  });

  it('hide() cierra el toast y cancela el temporizador', () => {
    service.show('uno');
    service.hide();
    expect(service.state()).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(service.state()).toBeNull();
  });
});

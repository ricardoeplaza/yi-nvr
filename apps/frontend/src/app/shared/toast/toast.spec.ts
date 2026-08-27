import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Toast } from './toast';
import { ToastService } from './toast.service';

describe('Toast', () => {
  let component: Toast;
  let fixture: ComponentFixture<Toast>;
  let host: HTMLElement;
  let service: ToastService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Toast],
    }).compileComponents();

    fixture = TestBed.createComponent(Toast);
    component = fixture.componentInstance;
    host = fixture.nativeElement;
    service = TestBed.inject(ToastService);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function toast(): HTMLElement {
    return host.querySelector('.toast') as HTMLElement;
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('arranca oculto y sin mensaje', () => {
    expect(toast().classList.contains('show')).toBe(false);
    expect(toast().querySelector('.toast-message')?.textContent).toBe('');
  });

  it('muestra el mensaje cuando el servicio lo activa', () => {
    service.show('Clip eliminado', 'success');
    fixture.detectChanges();
    expect(toast().classList.contains('show')).toBe(true);
    expect(toast().querySelector('.toast-message')?.textContent).toBe('Clip eliminado');
  });

  it('muestra el icono de éxito para el tipo success', () => {
    service.show('Listo', 'success');
    fixture.detectChanges();
    expect(toast().classList.contains('success')).toBe(true);
    expect(toast().querySelector('.toast-icon')).toBeTruthy();
  });

  it('muestra el icono de error para el tipo error', () => {
    service.show('Fallo', 'error');
    fixture.detectChanges();
    expect(toast().classList.contains('error')).toBe(true);
    expect(toast().querySelector('.toast-icon')).toBeTruthy();
  });

  it('muestra el icono de info para el tipo info', () => {
    service.show('Info');
    fixture.detectChanges();
    expect(toast().classList.contains('info')).toBe(true);
    expect(toast().querySelector('.toast-icon')).toBeTruthy();
  });

  it('se oculta cuando el servicio cierra el estado', () => {
    service.show('Hola');
    fixture.detectChanges();
    expect(toast().classList.contains('show')).toBe(true);
    service.hide();
    fixture.detectChanges();
    expect(toast().classList.contains('show')).toBe(false);
  });
});

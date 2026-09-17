import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { PowerService } from './power.service';
import { CameraService } from './camera.service';
import { ToastService } from '../shared/toast/toast.service';
import { I18nService } from '../shared/i18n/i18n.service';
import { I18N_KEYS } from '../../i18n/keys';

// Stub en español: las aserciones de este spec esperan el texto en español.
const i18nStub = {
  lang: 'es' as const,
  t: (key: string, params?: Record<string, string | number>) =>
    String(I18N_KEYS[key as keyof typeof I18N_KEYS]).replace(
      /\{\{(\w+)\}\}/g,
      (_m, name: string) => String(params?.[name] ?? ''),
    ),
  translateApiError: (err: unknown) => {
    const e = err as { error?: { error?: string }; message?: string } | null;
    return e?.error?.error || e?.message || 'Error desconocido';
  },
};

describe('PowerService', () => {
  let service: PowerService;
  let setPowerSpy: ReturnType<typeof vi.fn>;
  let toastShowSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setPowerSpy = vi.fn(() => of({ success: true, applied: true, key: 'switch_on', value: 'yes' }));
    toastShowSpy = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        PowerService,
        { provide: CameraService, useValue: { setPower: setPowerSpy } },
        { provide: ToastService, useValue: { show: toastShowSpy } },
        { provide: I18nService, useValue: i18nStub },
      ],
    });
    service = TestBed.inject(PowerService);
  });

  describe('seed', () => {
    it('registra el estado y lo refleja en isOn', () => {
      service.seed('cam1', true);
      expect(service.isOn('cam1')).toBe(true);

      service.seed('cam2', false);
      expect(service.isOn('cam2')).toBe(false);
    });

    it('no-op si el valor ya es igual (mismo objeto)', () => {
      service.seed('cam1', true);
      const antes = service.powers();
      service.seed('cam1', true);
      expect(service.powers()).toBe(antes);
    });

    it('isOn devuelve null para cámaras sin seed', () => {
      expect(service.isOn('camX')).toBeNull();
    });
  });

  describe('toggle', () => {
    it('off → on: actualiza el signal, llama setPower y muestra toast de éxito', () => {
      service.seed('cam1', false);
      service.toggle('cam1');

      expect(setPowerSpy).toHaveBeenCalledWith('cam1', true);
      expect(service.isOn('cam1')).toBe(true);
      expect(toastShowSpy).toHaveBeenCalledWith('Cámara encendida', 'success');
    });

    it('on → off: actualiza el signal, llama setPower y muestra toast de éxito', () => {
      service.seed('cam1', true);
      service.toggle('cam1');

      expect(setPowerSpy).toHaveBeenCalledWith('cam1', false);
      expect(service.isOn('cam1')).toBe(false);
      expect(toastShowSpy).toHaveBeenCalledWith('Cámara apagada', 'success');
    });

    it('sin seed usa el default false y pasa a true', () => {
      service.toggle('cam1');

      expect(setPowerSpy).toHaveBeenCalledWith('cam1', true);
      expect(service.isOn('cam1')).toBe(true);
    });

    it('rollback + toast de error si setPower falla', () => {
      setPowerSpy.mockReturnValue(throwError(() => new Error('boom')));
      service.seed('cam1', true);
      service.toggle('cam1');

      expect(service.isOn('cam1')).toBe(true);
      expect(toastShowSpy).toHaveBeenCalledWith('Error al cambiar el encendido', 'error');
    });
  });
});

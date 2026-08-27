import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { GalleryCard } from './gallery-card';
import { Video } from '../../models/video.model';

function makeVideo(id: number, extra: Partial<Video> = {}): Video {
  return {
    id,
    name: null,
    camera_name: 'cam1',
    timestamp: '2026-08-20T10:00:00Z',
    original_path: '',
    thumbnail_path: '',
    preview_path: '',
    duration: 90,
    file_size: 1024,
    favorite: false,
    original_url: `https://example.com/clip${id}.mp4`,
    thumbnail_url: `https://example.com/thumb${id}.jpg`,
    preview_url: `https://example.com/preview${id}.webp`,
    ...extra,
  };
}

@Component({
  imports: [GalleryCard],
  template: `
    <yi-gallery-card
      [video]="video()"
      [isSelected]="selected()"
      [selecting]="selecting()"
      [renaming]="renaming()"
      [renameValue]="renameValue()"
      [renameError]="renameError()"
      (select)="onSelect($event)"
      (play)="onPlay($event)"
      (favorite)="onFavorite($event)"
      (renameStart)="onRenameStart($event)"
      (renameInput)="onRenameInput($event)"
      (renameCommit)="onRenameCommit($event)"
      (renameCancel)="onRenameCancel()"
      (remove)="onRemove($event)"
    />
  `,
})
class HostComponent {
  video = signal<Video>(makeVideo(1));
  selected = signal(false);
  selecting = signal(false);
  renaming = signal(false);
  renameValue = signal('');
  renameError = signal<string | null>(null);
  onSelect = vi.fn();
  onPlay = vi.fn();
  onFavorite = vi.fn();
  onRenameStart = vi.fn();
  onRenameInput = vi.fn();
  onRenameCommit = vi.fn();
  onRenameCancel = vi.fn();
  onRemove = vi.fn();
}

describe('GalleryCard', () => {
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

  it('rendera thumbnail, cámara, duración y OSD', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const vid = host.video();
    const img = fixture.nativeElement.querySelector('.thumb-scene img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(vid.thumbnail_url);
    expect(fixture.nativeElement.querySelector('.camera-tag')!.textContent).toContain('cam1');
    expect(fixture.nativeElement.querySelector('.duration-badge')!.textContent).toContain('1:30');
    expect(fixture.nativeElement.querySelector('.osd')!.textContent).toContain('2026');
    fixture.destroy();
  });

  it('hover muestra el preview animado y al salir vuelve al thumbnail', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const vid = host.video();
    const img = () => fixture.nativeElement.querySelector('.thumb-scene img') as HTMLImageElement;
    const card = fixture.nativeElement.querySelector('.card') as HTMLElement;
    expect(img().getAttribute('src')).toBe(vid.thumbnail_url);
    card.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(img().getAttribute('src')).toBe(vid.preview_url);
    card.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(img().getAttribute('src')).toBe(vid.thumbnail_url);
    fixture.destroy();
  });

  it('sin preview_url se queda en el thumbnail aunque se haga hover', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.video.set({ ...host.video(), preview_url: '' });
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('.thumb-scene img') as HTMLImageElement;
    const card = fixture.nativeElement.querySelector('.card') as HTMLElement;
    card.dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(img.getAttribute('src')).toBe(host.video().thumbnail_url);
    fixture.destroy();
  });

  it('click en la thumb emite select con el video', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const thumb = fixture.nativeElement.querySelector('.thumb') as HTMLElement;
    thumb.click();
    expect(host.onSelect).toHaveBeenCalledWith(host.video());
    fixture.destroy();
  });

  it('click en play emite play', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    (fixture.nativeElement.querySelector('.play-btn') as HTMLElement).click();
    expect(host.onPlay).toHaveBeenCalledWith(host.video());
    fixture.destroy();
  });

  it('click en favorito emite favorite sin propagar select', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    (fixture.nativeElement.querySelector('.fav-toggle') as HTMLElement).click();
    expect(host.onFavorite).toHaveBeenCalledWith(host.video());
    expect(host.onSelect).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('isSelected y selecting aplican sus clases', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const card = () => fixture.nativeElement.querySelector('.card') as HTMLElement;
    expect(card().classList.contains('is-selected')).toBe(false);
    expect(card().classList.contains('selecting')).toBe(false);
    host.selected.set(true);
    host.selecting.set(true);
    fixture.detectChanges();
    expect(card().classList.contains('is-selected')).toBe(true);
    expect(card().classList.contains('selecting')).toBe(true);
    fixture.destroy();
  });

  it('sin renaming muestra título, botón de renombrar y de eliminar', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const vid = host.video();
    expect(fixture.nativeElement.querySelector('.card-title-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.card-title')!.textContent).toContain('Añadir nombre');
    (fixture.nativeElement.querySelector('.icon-mini') as HTMLElement).click();
    expect(host.onRenameStart).toHaveBeenCalledWith(vid);
    (fixture.nativeElement.querySelector('.icon-mini.danger') as HTMLElement).click();
    expect(host.onRemove).toHaveBeenCalledWith(vid);
    fixture.destroy();
  });

  it('con renaming muestra el input; Enter confirma, Escape cancela', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.renaming.set(true);
    host.renameValue.set('nuevo');
    fixture.detectChanges();
    const vid = host.video();
    const input = fixture.nativeElement.querySelector('.card-title-input') as HTMLInputElement;
    expect(input.value).toBe('nuevo');
    input.dispatchEvent(new Event('input'));
    expect(host.onRenameInput).toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host.onRenameCommit).toHaveBeenCalledWith(vid);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host.onRenameCancel).toHaveBeenCalled();
    fixture.destroy();
  });

  it('muestra el error de rename solo con renaming activo', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.renameError.set('No se pudo renombrar');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card-error')).toBeNull();
    host.renaming.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.card-error')!.textContent).toContain('No se pudo renombrar');
    fixture.destroy();
  });
});

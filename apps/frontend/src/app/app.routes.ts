import { Routes } from '@angular/router';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.page').then(m => m.LoginPage) },
  { path: '', loadComponent: () => import('./pages/dashboard/dashboard.page').then(m => m.DashboardPage), canActivate: [authGuard] },
  { path: 'cameras', loadComponent: () => import('./pages/cameras/cameras').then(m => m.Cameras), canActivate: [authGuard] },
  { path: 'cameras/:id', loadComponent: () => import('./pages/camera-detail/camera-detail.page').then(m => m.CameraDetailPage), canActivate: [authGuard] },
  { path: 'cameras/:id/storage', loadComponent: () => import('./pages/storage-management/storage.page').then(m => m.StoragePage), canActivate: [authGuard] },
  { path: 'videos', loadComponent: () => import('./pages/gallery/gallery.page').then(m => m.GalleryPage), canActivate: [authGuard] },
  { path: 'timeline', loadComponent: () => import('./pages/timeline/timeline.page').then(m => m.TimelinePage), canActivate: [authGuard] },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings.page').then(m => m.SettingsPage), canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];

export interface Video {
  id: number;
  camera_name: string;
  timestamp: string;
  original_path: string;
  thumbnail_path: string;
  preview_path: string;
  duration: number;
  file_size: number;
  favorite: boolean;
  original_url: string;
  thumbnail_url: string;
  preview_url: string;
}

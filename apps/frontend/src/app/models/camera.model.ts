export interface CameraCapabilities {
  led: boolean;
  ircut: boolean;
  rec_mode: boolean;
  power: boolean;
}

export interface Camera {
  id: string;
  name: string;
  host: string;
  capabilities: CameraCapabilities;
  has_videos: boolean;
  video_count: number;
  last_video: string | null;
}

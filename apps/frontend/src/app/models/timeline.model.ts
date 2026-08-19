export interface TimelineDay {
  date: string;
  total: number;
  cameras: Record<string, number>;
}

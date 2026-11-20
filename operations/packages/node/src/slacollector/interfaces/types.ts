export interface SLAEvent {
  timestamp: Date;
  metric: string;
  value: number;
  threshold: number;
  violated: boolean;
}

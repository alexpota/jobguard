export interface JobRecord {
  id: string;
  queue_name: string;
  queue_type: 'bull' | 'bullmq' | 'bee';
  job_id: string;
  job_name?: string;
  data: any;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
  started_at?: Date;
  completed_at?: Date;
  last_heartbeat?: Date;
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STUCK = 'stuck',
  DEAD = 'dead',
}

export interface JobStats {
  queueName: string;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  stuck: number;
  dead: number;
  total: number;
}

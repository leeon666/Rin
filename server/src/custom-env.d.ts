import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    CLOUDPASTE_API_BASE?: string;
    CLOUDPASTE_PUBLIC_BASE?: string;
    CLOUDPASTE_AUTH_TOKEN?: string;
    CLOUDPASTE_UPLOAD_PATH?: string;
    CLOUDPASTE_USERNAME?: string;
    CLOUDPASTE_PASSWORD?: string;
  }
}

export {};

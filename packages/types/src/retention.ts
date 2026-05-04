export interface RetentionEventsConfig {
  error?: string;
  audit?: string;
  channel?: string;
  install?: string;
}

export interface RetentionConfig {
  messages?: string;
  traces?: string;
  spans?: string;
  events?: RetentionEventsConfig;
  blobs?: string;
  archive?: string;
}

export const RETENTION_DEFAULTS: {
  messages: string;
  traces: string;
  spans: string;
  events: Required<RetentionEventsConfig>;
  blobs: string;
  archive: string;
} = {
  messages: '365d',
  traces: '90d',
  spans: '90d',
  events: {
    error: '90d',
    audit: '365d',
    channel: '365d',
    install: 'forever',
  },
  blobs: '7d',
  archive: '730d',
};

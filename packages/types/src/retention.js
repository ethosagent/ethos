export const RETENTION_DEFAULTS = {
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

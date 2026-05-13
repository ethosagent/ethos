export type EthosErrorCode =
  | 'NO_API_KEY'
  | 'CONNECTION_REFUSED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'STALE_VERSION'
  | 'UNKNOWN';

export class EthosError extends Error {
  readonly code: EthosErrorCode;
  readonly action?: string;

  constructor(opts: { code: EthosErrorCode; message: string; action?: string }) {
    super(opts.message);
    this.name = 'EthosError';
    this.code = opts.code;
    this.action = opts.action;
  }
}

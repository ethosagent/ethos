export class EthosError extends Error {
  code;
  action;
  constructor(opts) {
    super(opts.message);
    this.name = 'EthosError';
    this.code = opts.code;
    this.action = opts.action;
  }
}

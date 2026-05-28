import { EventEmitter } from 'node:events';
export class SystemEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
  emitSystem(data) {
    return this.emit('system', data);
  }
  onSystem(listener) {
    return this.on('system', listener);
  }
  offSystem(listener) {
    return this.off('system', listener);
  }
}

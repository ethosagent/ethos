import { EventEmitter } from 'node:events';

export type SystemEvent =
  | { type: 'cron.completed'; jobId: string; jobName: string; ok: boolean; durationMs: number }
  | { type: 'cron.failed'; jobId: string; jobName: string; error: string }
  | { type: 'platform.connected'; platformId: string; botUsername?: string }
  | { type: 'platform.disconnected'; platformId: string; reason?: string }
  | { type: 'bot.message'; platformId: string; preview: string; sessionId: string }
  | { type: 'session.titled'; sessionId: string; title: string }
  | { type: 'health'; status: 'ok' | 'degraded'; detail?: string }
  | { type: 'ping' };

interface SystemBusEvents {
  system: [data: SystemEvent];
}

export class SystemEventBus extends EventEmitter<SystemBusEvents> {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  emitSystem(data: SystemEvent): boolean {
    return this.emit('system', data);
  }

  onSystem(listener: (data: SystemEvent) => void): this {
    return this.on('system', listener);
  }

  offSystem(listener: (data: SystemEvent) => void): this {
    return this.off('system', listener);
  }
}

import { describe, expect, it } from 'vitest';
import type { OtlpDisabled, OtlpSettings } from '../settings';
import { resolveOtlpSettings } from '../settings';

const ENABLED = { enabled: true, endpoint: 'http://localhost:4318' };

function expectEnabled(result: OtlpSettings | OtlpDisabled): OtlpSettings {
  if ('disabled' in result) {
    throw new Error(`expected enabled settings, got disabled: ${result.reason}`);
  }
  return result;
}

function expectDisabled(result: OtlpSettings | OtlpDisabled): OtlpDisabled {
  if (!('disabled' in result)) {
    throw new Error('expected disabled settings, got enabled');
  }
  return result;
}

describe('resolveOtlpSettings — enablement', () => {
  it('is disabled when config enabled is unset, even with an env endpoint (env never enables)', () => {
    const result = expectDisabled(
      resolveOtlpSettings(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
    );
    expect(result.reason).toContain('enabled');
  });

  it('is disabled when config enabled is false', () => {
    expectDisabled(
      resolveOtlpSettings(
        { enabled: false, endpoint: 'http://localhost:4318' },
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' },
      ),
    );
  });

  it('is disabled by OTEL_SDK_DISABLED=true', () => {
    const result = expectDisabled(resolveOtlpSettings(ENABLED, { OTEL_SDK_DISABLED: 'true' }));
    expect(result.reason).toContain('OTEL_SDK_DISABLED');
  });

  it('is disabled by an unsupported OTEL_EXPORTER_OTLP_PROTOCOL, naming the protocol', () => {
    const grpc = expectDisabled(
      resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }),
    );
    expect(grpc.reason).toContain('grpc');
    const protobuf = expectDisabled(
      resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' }),
    );
    expect(protobuf.reason).toContain('http/protobuf');
  });

  it('accepts OTEL_EXPORTER_OTLP_PROTOCOL=http/json', () => {
    expectEnabled(resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }));
  });

  it('is disabled when no endpoint is configured anywhere', () => {
    const result = expectDisabled(resolveOtlpSettings({ enabled: true }, {}));
    expect(result.reason).toContain('endpoint');
  });
});

describe('resolveOtlpSettings — endpoint precedence', () => {
  it('uses OTEL_EXPORTER_OTLP_TRACES_ENDPOINT verbatim, above everything', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(ENABLED, {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/custom/traces/',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://other.example',
      }),
    );
    expect(settings.tracesUrl).toBe('https://collector.example/custom/traces/');
  });

  it('appends /v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT, above the config endpoint', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/' }),
    );
    expect(settings.tracesUrl).toBe('https://collector.example/v1/traces');
  });

  it('appends /v1/traces to the config endpoint when no env endpoint is set', () => {
    const settings = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    expect(settings.tracesUrl).toBe('http://localhost:4318/v1/traces');
  });
});

describe('resolveOtlpSettings — headers', () => {
  it('merges config < OTEL_EXPORTER_OTLP_HEADERS < OTEL_EXPORTER_OTLP_TRACES_HEADERS, percent-decoded', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(
        {
          ...ENABLED,
          headers: { Authorization: 'Basic from-config', 'x-a': 'from-config' },
        },
        {
          OTEL_EXPORTER_OTLP_HEADERS: 'x-a=env%20general, x-b=general',
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-b=traces%2Bwins',
        },
      ),
    );
    expect(settings.headers).toEqual({
      Authorization: 'Basic from-config',
      'x-a': 'env general',
      'x-b': 'traces+wins',
    });
  });
});

describe('resolveOtlpSettings — resource', () => {
  it('defaults service.name to ethos and carries host/pid/instance defaults', () => {
    const settings = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    expect(settings.resource['service.name']).toBe('ethos');
    expect(typeof settings.resource['host.name']).toBe('string');
    expect(settings.resource['process.pid']).toBe(process.pid);
    expect(String(settings.resource['service.instance.id'])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('mints a fresh service.instance.id per resolve', () => {
    const a = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    const b = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    expect(a.resource['service.instance.id']).not.toBe(b.resource['service.instance.id']);
  });

  it('lands OTEL_RESOURCE_ATTRIBUTES pairs on the resource, OTEL_SERVICE_NAME winning service.name', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(ENABLED, {
        OTEL_SERVICE_NAME: 'my-agent',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=ignored,deployment.environment=prod%2Feu',
      }),
    );
    expect(settings.resource['service.name']).toBe('my-agent');
    expect(settings.resource['deployment.environment']).toBe('prod/eu');
  });

  it('carries service.version only when the caller passes one', () => {
    const withVersion = expectEnabled(
      resolveOtlpSettings(ENABLED, {}, { serviceVersion: '1.2.3' }),
    );
    expect(withVersion.resource['service.version']).toBe('1.2.3');
    const without = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    expect(without.resource).not.toHaveProperty('service.version');
  });
});

describe('resolveOtlpSettings — timeout and defaults', () => {
  it('parses OTEL_EXPORTER_OTLP_TIMEOUT as milliseconds', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_TIMEOUT: '5000' }),
    );
    expect(settings.timeoutMs).toBe(5000);
  });

  it('defaults the timeout to 10000ms, including on an unparseable value', () => {
    expect(expectEnabled(resolveOtlpSettings(ENABLED, {})).timeoutMs).toBe(10_000);
    expect(
      expectEnabled(resolveOtlpSettings(ENABLED, { OTEL_EXPORTER_OTLP_TIMEOUT: 'soon' })).timeoutMs,
    ).toBe(10_000);
  });

  it('applies the documented defaults for the poller knobs', () => {
    const settings = expectEnabled(resolveOtlpSettings(ENABLED, {}));
    expect(settings.includeContent).toBe(false);
    expect(settings.intervalMs).toBe(15_000);
    expect(settings.backlogMaxAgeMs).toBe(86_400_000);
  });

  it('honors config values for the poller knobs', () => {
    const settings = expectEnabled(
      resolveOtlpSettings(
        { ...ENABLED, includeContent: true, intervalMs: 3_000, backlogMaxAgeMs: 60_000 },
        {},
      ),
    );
    expect(settings.includeContent).toBe(true);
    expect(settings.intervalMs).toBe(3_000);
    expect(settings.backlogMaxAgeMs).toBe(60_000);
  });
});

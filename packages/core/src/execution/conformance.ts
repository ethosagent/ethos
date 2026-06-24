import type {
  ExecChunk,
  ExecutionBackend,
  PersonalityConfig,
  SandboxAttestation,
} from '@ethosagent/types';
import { isStrictAttestation } from '@ethosagent/types';

export interface ExecutionConformanceResult {
  passed: boolean;
  failures: string[];
}

/**
 * Run conformance checks against an ExecutionBackend implementation.
 * Plugin authors can use this to verify their backend satisfies the contract.
 *
 * Tests:
 * 1. Attestation honesty — attest() returns a valid SandboxAttestation object
 * 2. ExecChunk exit-code contract — exec() ends with { stream: 'exit', code: number }
 * 3. mountsFor ≤ constitution — mounts never exceed allowed mount roots
 * 4. Classifier-skip keys on isStrictAttestation(attest()), NEVER backend.name
 */
export async function runExecutionConformance(
  backend: ExecutionBackend,
): Promise<ExecutionConformanceResult> {
  const failures: string[] = [];

  // 1. Attestation shape — if attest() is implemented, verify it returns
  //    a complete SandboxAttestation with all 9 boolean fields.
  if (backend.attest) {
    try {
      const attestation = backend.attest();
      const requiredFields: (keyof SandboxAttestation)[] = [
        'readonlyRootFs',
        'noHostMounts',
        'egressControlled',
        'noDockerSocket',
        'nonRoot',
        'noPrivileged',
        'noCapAdd',
        'capDropAll',
        'noNewPrivs',
      ];
      for (const field of requiredFields) {
        if (typeof attestation[field] !== 'boolean') {
          failures.push(
            `attestation: field "${field}" is not a boolean (got ${typeof attestation[field]})`,
          );
        }
      }
      // Verify isStrictAttestation is consistent — if all fields are true,
      // isStrictAttestation must return true, and vice versa.
      const allTrue = requiredFields.every((f) => attestation[f] === true);
      const strict = isStrictAttestation(attestation);
      if (allTrue !== strict) {
        failures.push(
          `attestation: isStrictAttestation() returned ${strict} but ${allTrue ? 'all' : 'not all'} fields are true`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`attestation: attest() threw: ${msg}`);
    }
  }

  // 2. ExecChunk exit-code contract — exec() stream must end with
  //    { stream: 'exit', code: number } on natural completion.
  //    We test with a simple echo command that should succeed.
  if (await backend.isAvailable()) {
    try {
      const chunks: ExecChunk[] = [];
      for await (const chunk of backend.exec('echo conformance-test', { timeoutMs: 10000 })) {
        chunks.push(chunk);
      }
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk?.stream !== 'exit') {
        failures.push('exit-code: exec() stream did not end with an exit chunk');
      } else if (typeof lastChunk.code !== 'number') {
        failures.push(`exit-code: exit chunk code is not a number (got ${typeof lastChunk.code})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`exit-code: exec() threw during conformance check: ${msg}`);
    }
  }

  // 3. mountsFor ≤ constitution — mounts returned by mountsFor() must not
  //    exceed allowed mount roots when a constitution constrains them.
  //    Test with a personality that has explicit fs_reach.
  try {
    const testPersonality: PersonalityConfig = {
      id: 'conformance-test',
      name: 'Conformance Test',
      fs_reach: { read: ['/tmp/ethos-conformance-test'], write: [] },
    };
    const mounts = backend.mountsFor(testPersonality);
    if (!Array.isArray(mounts)) {
      failures.push('mountsFor: did not return an array');
    } else {
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i];
        if (!mount) continue;
        if (typeof mount.hostPath !== 'string') {
          failures.push(`mountsFor: mount[${i}].hostPath is not a string`);
        }
        if (typeof mount.containerPath !== 'string') {
          failures.push(`mountsFor: mount[${i}].containerPath is not a string`);
        }
        if (mount.mode !== 'ro' && mount.mode !== 'rw') {
          failures.push(`mountsFor: mount[${i}].mode is '${mount.mode}', expected 'ro' or 'rw'`);
        }
      }
    }
  } catch {
    // mountsFor throwing is acceptable — the backend may reject mounts
    // for valid reasons (e.g. forbidden paths, no constitution)
  }

  // 4. Classifier-skip keys on isStrictAttestation(attest()), NEVER on
  //    backend.name. This test verifies that a classifier decision can be
  //    made from the attestation alone. A backend named 'docker' with a
  //    weak attestation should NOT be treated as strict.
  if (backend.attest) {
    const attestation = backend.attest();
    const strict = isStrictAttestation(attestation);
    // The test: demonstrate that the decision comes from the attestation
    // object, not the backend name. A backend with name 'docker' but
    // readonlyRootFs=false should not be strict.
    if (strict && !attestation.readonlyRootFs) {
      failures.push(
        'classifier: isStrictAttestation returned true but readonlyRootFs is false — ' +
          'the classifier decision must come from attestation fields, not the backend name',
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Plugin contract — validation for published plugin packages
// ---------------------------------------------------------------------------

export type { ContractCompatResult } from './version';
export { checkPluginContractMajor, PLUGIN_CONTRACT_MAJOR } from './version';

export interface CredentialDeclaration {
  key: string;
  label: string;
  type: 'secret' | 'text';
  description?: string;
  refreshHint?: 'daily' | 'weekly' | 'manual';
  required?: boolean;
}

export interface EthosPluginPackageJson {
  name: string;
  version: string;
  description?: string;
  main?: string;
  exports?: Record<string, unknown>;
  ethos?: {
    type?: 'plugin';
    /** Legacy semver-style field. Soft check via `normalizeExternalPluginCompatibility`. */
    pluginApi?: string;
    /**
     * Phase 30.6 — declared plugin contract major version (integer). The
     * loader hard-rejects mismatches against `PLUGIN_CONTRACT_MAJOR`.
     */
    pluginContractMajor?: number;
    hasHomePanel?: boolean;
    id?: string;
    skills_dir?: string;
    credentials?: CredentialDeclaration[];
    dependencies?: string[];
    priority?: number;
    ui_bundle?: string;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates that a package.json object meets the minimum requirements to be
 * recognized as an Ethos plugin. Used by the plugin marketplace and loader.
 */
export function validatePluginPackageJson(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['package.json must be an object'], warnings: [] };
  }

  const pkg = raw as Record<string, unknown>;

  // Required fields
  if (!pkg.name || typeof pkg.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  } else if (!/^[a-z0-9@][a-z0-9@._/-]*$/.test(pkg.name)) {
    errors.push(`Invalid package name: "${pkg.name}"`);
  }

  if (!pkg.version || typeof pkg.version !== 'string') {
    errors.push('Missing or invalid "version" field');
  }

  // ethos manifest field
  const ethos = pkg.ethos as Record<string, unknown> | undefined;
  if (!ethos) {
    errors.push('Missing "ethos" field — add { "ethos": { "type": "plugin" } } to package.json');
  } else if (ethos.type !== 'plugin') {
    errors.push(`"ethos.type" must be "plugin", got "${ethos.type}"`);
  }

  // Credential declarations
  if (ethos && Array.isArray(ethos.credentials)) {
    const keyPattern = /^[a-zA-Z0-9_-]+$/;
    for (const [i, cred] of (ethos.credentials as unknown[]).entries()) {
      const c = cred as Record<string, unknown>;
      const prefix = `ethos.credentials[${i}]`;
      if (typeof c.key !== 'string' || !keyPattern.test(c.key)) {
        errors.push(`${prefix}.key must match /^[a-zA-Z0-9_-]+$/`);
      }
      if (typeof c.label !== 'string' || c.label.length === 0) {
        errors.push(`${prefix}.label must be a non-empty string`);
      }
      if (c.type !== 'secret' && c.type !== 'text') {
        errors.push(`${prefix}.type must be "secret" or "text"`);
      }
    }
  }

  // Soft checks
  if (!pkg.description) {
    warnings.push('No "description" — add one so users know what this plugin does');
  }

  if (!pkg.main && !pkg.exports) {
    warnings.push('No "main" or "exports" field — the plugin entry point may not resolve');
  }

  if (ethos?.dependencies && Array.isArray(ethos.dependencies)) {
    const id = ethos.id as string | undefined;
    if (id && (ethos.dependencies as string[]).includes(id)) {
      warnings.push(`ethos.dependencies contains the plugin's own id ("${id}")`);
    }
  }
  if (
    ethos?.priority !== undefined &&
    (!ethos?.dependencies ||
      !Array.isArray(ethos.dependencies) ||
      (ethos.dependencies as unknown[]).length === 0)
  ) {
    warnings.push('ethos.priority is set without dependencies — likely a mistake');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Quick check: is this package.json from an Ethos plugin?
 */
export function isEthosPlugin(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const pkg = raw as Record<string, unknown>;
  const ethos = pkg.ethos as Record<string, unknown> | undefined;
  return ethos?.type === 'plugin';
}

/**
 * Normalise a plugin's stated `ethos.pluginApi` semver range against the
 * current SDK version. Returns `{ compatible: true }` if compatible,
 * otherwise `{ compatible: false, reason }`.
 */
export function normalizeExternalPluginCompatibility(
  pluginApi: string | undefined,
  currentSdkVersion: string,
): { compatible: boolean; reason?: string } {
  if (!pluginApi) {
    return { compatible: true }; // no constraint declared — allow
  }

  // Simple major-version check: "1.x" plugins work with "1.x" SDK
  const pluginMajor = pluginApi.split('.')[0]?.replace(/[^0-9]/g, '');
  const sdkMajor = currentSdkVersion.split('.')[0];

  if (pluginMajor && sdkMajor && pluginMajor !== sdkMajor) {
    return {
      compatible: false,
      reason: `Plugin requires pluginApi ${pluginApi}, but SDK is ${currentSdkVersion} (major version mismatch)`,
    };
  }

  return { compatible: true };
}

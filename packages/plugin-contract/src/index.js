// ---------------------------------------------------------------------------
// Plugin contract — validation for published plugin packages
// ---------------------------------------------------------------------------
export { checkPluginContractMajor, PLUGIN_CONTRACT_MAJOR } from './version';
/**
 * Validates that a package.json object meets the minimum requirements to be
 * recognized as an Ethos plugin. Used by the plugin marketplace and loader.
 */
export function validatePluginPackageJson(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['package.json must be an object'], warnings: [] };
  }
  const pkg = raw;
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
  const ethos = pkg.ethos;
  if (!ethos) {
    errors.push('Missing "ethos" field — add { "ethos": { "type": "plugin" } } to package.json');
  } else if (ethos.type !== 'plugin') {
    errors.push(`"ethos.type" must be "plugin", got "${ethos.type}"`);
  }
  // Soft checks
  if (!pkg.description) {
    warnings.push('No "description" — add one so users know what this plugin does');
  }
  if (!pkg.main && !pkg.exports) {
    warnings.push('No "main" or "exports" field — the plugin entry point may not resolve');
  }
  return { valid: errors.length === 0, errors, warnings };
}
/**
 * Quick check: is this package.json from an Ethos plugin?
 */
export function isEthosPlugin(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const pkg = raw;
  const ethos = pkg.ethos;
  return ethos?.type === 'plugin';
}
/**
 * Normalise a plugin's stated `ethos.pluginApi` semver range against the
 * current SDK version. Returns `{ compatible: true }` if compatible,
 * otherwise `{ compatible: false, reason }`.
 */
export function normalizeExternalPluginCompatibility(pluginApi, currentSdkVersion) {
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

import type { ScanFinding, ScanResult } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PluginScanPermissions {
  /** Plugin is allowed to spawn shell processes. Downgrades shell-exec findings to yellow. */
  shell?: boolean;
  /**
   * Hosts the plugin is permitted to contact.
   * - `undefined`: no network permission declared → flag all network calls
   * - `[]`: permission declared, no host restriction → suppress all network findings
   * - `['api.example.com', ...]`: specific hosts → validate URL literals; flag others
   */
  network?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLines(content: string): string[] {
  return content.split('\n');
}

function excerptLine(line: string, maxLen = 80): string {
  const trimmed = line.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
}

function makeResult(findings: ScanFinding[]): ScanResult {
  return {
    findings,
    hasRed: findings.some((f) => f.severity === 'red'),
    hasYellow: findings.some((f) => f.severity === 'yellow'),
  };
}

// ---------------------------------------------------------------------------
// RED: Dynamic code execution
// ---------------------------------------------------------------------------

const DYNAMIC_CODE_PATTERNS: RegExp[] = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bvm\.runInNewContext\s*\(/,
  /\bvm\.runInThisContext\s*\(/,
  // Function constructor called without `new` — e.g. Function('return this')()
  /\bFunction\s*\(/,
  // process.binding / process.dlopen — low-level native module loading
  /\bprocess\.binding\s*\(/,
  /\bprocess\.dlopen\s*\(/,
];

function checkDynamicCodeExec(lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const pattern of DYNAMIC_CODE_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          severity: 'red',
          rule: 'dynamic-code-exec',
          message: 'Dynamic code execution: eval/Function/vm',
          line: i + 1,
          excerpt: excerptLine(line),
        });
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// RED: Require aliasing / indirect eval evasion
// ---------------------------------------------------------------------------

/**
 * Catches evasion patterns that bypass the direct regex checks above:
 *  - `const r = require; r('child_process')` (require aliasing)
 *  - `const e = eval; e(code)` (eval aliasing)
 *  - `globalThis['eval'](...)` or `global['eval'](...)` (bracket-access eval)
 *  - `this['eval'](...)` or `this.constructor('...')()` — indirect eval
 *  - `('ev' + 'al')` — string-concatenation to construct 'eval'
 */
const EVASION_PATTERNS: RegExp[] = [
  // require assigned to another variable: const r = require; / let fn = require;
  /\b(?:const|let|var)\s+\w+\s*=\s*require\s*[;,]/,
  // eval assigned to another variable: const e = eval; / let x = eval;
  /\b(?:const|let|var)\s+\w+\s*=\s*eval\s*[;,]/,
  // bracket-access eval on globalThis / global / window / self / this
  /\b(?:globalThis|global|window|self|this)\s*\[\s*['"`]eval['"`]\s*\]/,
  // string concatenation that produces 'eval' — e.g. 'ev' + 'al' or `ev${'al'}`
  /['"`]ev['"`]\s*\+\s*['"`]al['"`]/,
  // this.constructor used to get Function — e.g. this.constructor('return this')()
  /\bthis\.constructor\s*\(/,
];

function checkEvasionPatterns(lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const pattern of EVASION_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          severity: 'red',
          rule: 'dynamic-code-exec',
          message: 'Indirect dynamic code execution (aliasing or string evasion)',
          line: i + 1,
          excerpt: excerptLine(line),
        });
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// RED/YELLOW: Shell execution
// ---------------------------------------------------------------------------

const SHELL_EXEC_PATTERNS: RegExp[] = [
  /\bchild_process\.spawn\s*\(/,
  /\bchild_process\.exec\s*\(/,
  /\bchild_process\.execSync\s*\(/,
  /\bchild_process\.spawnSync\s*\(/,
  /\bshelljs\b/,
];

function checkShellExec(lines: string[], permissions: PluginScanPermissions): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const hasShellPerm = permissions.shell === true;

  // Heuristic: check if child_process is imported anywhere (with or without node: prefix)
  const fullContent = lines.join('\n');
  const hasChildProcessImport =
    /require\(['"](?:node:)?child_process['"]\)/.test(fullContent) ||
    /from\s+['"](?:node:)?child_process['"]/.test(fullContent) ||
    /import\s+.*(?:node:)?child_process/.test(fullContent);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let matched = false;

    for (const pattern of SHELL_EXEC_PATTERNS) {
      if (pattern.test(line)) {
        matched = true;
        break;
      }
    }

    // Also catch .exec( or bare exec( / spawn( / execSync( when child_process is imported in file
    if (
      !matched &&
      hasChildProcessImport &&
      /(?:\.|^|\s)(exec|spawn|execSync|spawnSync)\s*\(/.test(line)
    ) {
      matched = true;
    }

    if (matched) {
      const severity = hasShellPerm ? 'yellow' : 'red';
      findings.push({
        severity,
        rule: 'shell-exec',
        message: 'Shell command execution detected',
        line: i + 1,
        excerpt: excerptLine(line),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// YELLOW: Network access
// ---------------------------------------------------------------------------

const NETWORK_ACCESS_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /\bhttp\.request\s*\(/,
  /\bhttps\.request\s*\(/,
  /\baxios\.get\s*\(/,
  /\baxios\.post\s*\(/,
  /\baxios\s*\(/,
];

// Extracts the hostname from a URL string literal on the same line.
// Matches fetch('https://api.example.com/...') → 'api.example.com'
const URL_LITERAL_PATTERN = /['"]https?:\/\/([^/'" ?#\s]+)/i;

function extractHostFromLine(line: string): string | null {
  const m = URL_LITERAL_PATTERN.exec(line);
  return m ? (m[1] ?? null) : null;
}

function checkNetworkAccess(lines: string[], permissions: PluginScanPermissions): ScanFinding[] {
  const { network } = permissions;
  // All hosts allowed (declared with no host restriction) — suppress findings
  if (network !== undefined && network.length === 0) return [];

  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    let matched = false;
    for (const pattern of NETWORK_ACCESS_PATTERNS) {
      if (pattern.test(line)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;

    if (network === undefined) {
      // No network permission declared
      findings.push({
        severity: 'yellow',
        rule: 'network-access',
        message: 'Outbound network call without declared network permission',
        line: i + 1,
        excerpt: excerptLine(line),
      });
    } else {
      // Specific hosts declared — validate URL literals
      const host = extractHostFromLine(line);
      if (host === null) {
        findings.push({
          severity: 'yellow',
          rule: 'network-access',
          message: `Network call to dynamic URL — cannot verify against declared hosts: [${network.join(', ')}]`,
          line: i + 1,
          excerpt: excerptLine(line),
        });
      } else if (!network.some((h) => host === h || host.endsWith(`.${h}`))) {
        findings.push({
          severity: 'yellow',
          rule: 'network-access',
          message: `Network call to undeclared host '${host}' — declared: [${network.join(', ')}]`,
          line: i + 1,
          excerpt: excerptLine(line),
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// RED: Credential path access
// ---------------------------------------------------------------------------

const CREDENTIAL_PATH_PATTERNS: RegExp[] = [
  /['"`][^'"`]*\/\.ssh[^'"`]*['"`]/,
  /['"`][^'"`]*\/\.aws[^'"`]*['"`]/,
  /['"`][^'"`]*\/\.gnupg[^'"`]*['"`]/,
  /['"`][^'"`]*\/\.netrc[^'"`]*['"`]/,
  /['"`][^'"`]*\/\.npmrc[^'"`]*['"`]/,
];

// Matches process.env.VAR_NAME (dot access)
const SENSITIVE_ENV_DOT_PATTERN = /\bprocess\.env\.([A-Z_][A-Z_0-9]*)/g;
// Matches process.env['VAR_NAME'] or process.env["VAR_NAME"]
const SENSITIVE_ENV_BRACKET_PATTERN = /\bprocess\.env\[['"`]([^'"`]+)['"`]\]/g;
const SENSITIVE_KEY_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

function isSensitiveEnvVar(line: string): boolean {
  SENSITIVE_ENV_DOT_PATTERN.lastIndex = 0;
  let match = SENSITIVE_ENV_DOT_PATTERN.exec(line);
  while (match !== null) {
    const varName = match[1] ?? '';
    if (varName && SENSITIVE_KEY_PATTERN.test(varName)) return true;
    match = SENSITIVE_ENV_DOT_PATTERN.exec(line);
  }

  SENSITIVE_ENV_BRACKET_PATTERN.lastIndex = 0;
  let bMatch = SENSITIVE_ENV_BRACKET_PATTERN.exec(line);
  while (bMatch !== null) {
    const varName = bMatch[1] ?? '';
    if (varName && SENSITIVE_KEY_PATTERN.test(varName)) return true;
    bMatch = SENSITIVE_ENV_BRACKET_PATTERN.exec(line);
  }

  return false;
}

function checkCredentialAccess(lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Check for credential paths
    let pathMatched = false;
    for (const pattern of CREDENTIAL_PATH_PATTERNS) {
      if (pattern.test(line)) {
        pathMatched = true;
        break;
      }
    }

    if (pathMatched || isSensitiveEnvVar(line)) {
      findings.push({
        severity: 'red',
        rule: 'credential-access',
        message: 'Access to credential path or sensitive env var',
        line: i + 1,
        excerpt: excerptLine(line),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// RED: Filesystem writes outside safe paths
// ---------------------------------------------------------------------------

// Matches fs write calls with a string literal first argument
const FS_WRITE_STRING_PATTERN =
  /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(\s*(['"`])(.*?)\2/;
// Matches fs write calls where the first argument is an expression (not a string literal)
const FS_WRITE_CALL_PATTERN = /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/;
const ENV_HOME_PATTERN = /process\.env(?:\.HOME|\['HOME'\]|\.HOME\b)/;

function checkFsWriteOutsideSafePath(lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Check string-literal path argument
    const match = FS_WRITE_STRING_PATTERN.exec(line);
    if (match) {
      const pathArg = match[3] ?? '';
      if (pathArg.startsWith('/') && !pathArg.includes('.ethos')) {
        findings.push({
          severity: 'red',
          rule: 'fs-write-outside-safe-path',
          message: 'Filesystem write to potentially unsafe path',
          line: i + 1,
          excerpt: excerptLine(line),
        });
        continue;
      }
    }

    // Check for env-based path used as first arg (process.env.HOME + ...)
    if (FS_WRITE_CALL_PATTERN.test(line) && ENV_HOME_PATTERN.test(line)) {
      findings.push({
        severity: 'red',
        rule: 'fs-write-outside-safe-path',
        message: 'Filesystem write to potentially unsafe path',
        line: i + 1,
        excerpt: excerptLine(line),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// YELLOW: Exfiltration shape
// ---------------------------------------------------------------------------

const ENCODE_PATTERNS: RegExp[] = [
  /\bbtoa\s*\(/,
  /\bBuffer\.from\s*\(.*\)\.toString\s*\(\s*['"`]base64['"`]\s*\)/,
];
const POST_PATTERNS: RegExp[] = [/\bfetch\s*\(/, /\.post\s*\(/];

function checkExfilShape(lines: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    let hasEncode = false;
    for (const pattern of ENCODE_PATTERNS) {
      if (pattern.test(line)) {
        hasEncode = true;
        break;
      }
    }

    if (!hasEncode) continue;

    // Check within 5 lines after for a fetch/post
    const end = Math.min(i + 5, lines.length - 1);
    for (let j = i; j <= end; j++) {
      const nextLine = lines[j] ?? '';
      for (const pattern of POST_PATTERNS) {
        if (pattern.test(nextLine)) {
          findings.push({
            severity: 'yellow',
            rule: 'exfil-shape',
            message: 'base64-encode followed by HTTP post — potential exfiltration shape',
            line: i + 1,
            excerpt: excerptLine(line),
          });
          break;
        }
      }
      // Break after first match found for this encode line
      if (findings.length > 0 && findings[findings.length - 1]?.line === i + 1) break;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scanPluginCode(
  content: string,
  permissions: PluginScanPermissions = {},
): ScanResult {
  const lines = buildLines(content);

  const findings: ScanFinding[] = [
    ...checkDynamicCodeExec(lines),
    ...checkEvasionPatterns(lines),
    ...checkShellExec(lines, permissions),
    ...checkNetworkAccess(lines, permissions),
    ...checkCredentialAccess(lines),
    ...checkFsWriteOutsideSafePath(lines),
    ...checkExfilShape(lines),
  ];

  return makeResult(findings);
}

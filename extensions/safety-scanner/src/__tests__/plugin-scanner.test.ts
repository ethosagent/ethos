import { describe, expect, it } from 'vitest';
import type { PluginScanPermissions } from '../plugin-scanner';
import { scanPluginCode } from '../plugin-scanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findingsByRule(
  content: string,
  rule: string,
  permissions: PluginScanPermissions = {},
): ReturnType<typeof scanPluginCode>['findings'] {
  return scanPluginCode(content, permissions).findings.filter((f) => f.rule === rule);
}

// ---------------------------------------------------------------------------
// Dynamic code execution
// ---------------------------------------------------------------------------

describe('scanPluginCode — dynamic code execution', () => {
  it('detects eval(', () => {
    const code = 'const result = eval(userInput);';
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    expect(findingsByRule(code, 'dynamic-code-exec').length).toBeGreaterThan(0);
  });

  it('detects new Function(', () => {
    const code = 'const fn = new Function("return 1");';
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    expect(findingsByRule(code, 'dynamic-code-exec').length).toBeGreaterThan(0);
  });

  it('detects vm.runInNewContext(', () => {
    const code = "import vm from 'node:vm';\nvm.runInNewContext(code, {});";
    expect(scanPluginCode(code).hasRed).toBe(true);
  });

  it('detects vm.runInThisContext(', () => {
    const code = 'vm.runInThisContext(script);';
    expect(scanPluginCode(code).hasRed).toBe(true);
  });

  it('flags eval at the correct line number', () => {
    const code = 'const x = 1;\nconst r = eval(data);\n';
    const findings = findingsByRule(code, 'dynamic-code-exec');
    expect(findings[0]?.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

describe('scanPluginCode — shell execution', () => {
  it('flags child_process.exec( as red without shell permission', () => {
    const code = "import { exec } from 'child_process';\nexec('ls', cb);";
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    const findings = findingsByRule(code, 'shell-exec');
    expect(findings[0]?.severity).toBe('red');
  });

  it('downgrades child_process.exec( to yellow with shell permission', () => {
    const code = "import { exec } from 'child_process';\nexec('ls', cb);";
    const result = scanPluginCode(code, { shell: true });
    expect(result.hasRed).toBe(false);
    const findings = findingsByRule(code, 'shell-exec', { shell: true });
    expect(findings[0]?.severity).toBe('yellow');
  });

  it('flags child_process.spawn( as red without shell permission', () => {
    const code = 'child_process.spawn("cmd", []);';
    expect(scanPluginCode(code).hasRed).toBe(true);
  });

  it('flags child_process.execSync( as red', () => {
    const code = 'child_process.execSync("rm -rf /");';
    expect(findingsByRule(code, 'shell-exec').length).toBeGreaterThan(0);
  });

  it('flags shelljs usage', () => {
    const code = "import shelljs from 'shelljs';";
    expect(findingsByRule(code, 'shell-exec').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Network access
// ---------------------------------------------------------------------------

describe('scanPluginCode — network access', () => {
  it('flags fetch( as yellow without network permission', () => {
    const code = 'const resp = await fetch(url);';
    const result = scanPluginCode(code);
    expect(result.hasYellow).toBe(true);
    const findings = findingsByRule(code, 'network-access');
    expect(findings[0]?.severity).toBe('yellow');
  });

  it('does NOT flag fetch( when network declared with no host restriction', () => {
    const code = 'const resp = await fetch(url);';
    const result = scanPluginCode(code, { network: [] });
    expect(findingsByRule(code, 'network-access', { network: [] }).length).toBe(0);
    expect(result.hasYellow).toBe(false);
  });

  it('flags fetch to undeclared host when specific hosts are declared', () => {
    const code = "const resp = await fetch('https://evil.com/data');";
    const result = scanPluginCode(code, { network: ['api.trusted.com'] });
    expect(result.hasYellow).toBe(true);
    const findings = findingsByRule(code, 'network-access', { network: ['api.trusted.com'] });
    expect(findings[0]?.message).toContain('undeclared host');
  });

  it('does NOT flag fetch to a declared host', () => {
    const code = "const resp = await fetch('https://api.trusted.com/endpoint');";
    expect(findingsByRule(code, 'network-access', { network: ['api.trusted.com'] }).length).toBe(0);
  });

  it('does NOT flag fetch to a subdomain of a declared host', () => {
    const code = "const resp = await fetch('https://sub.trusted.com/endpoint');";
    expect(findingsByRule(code, 'network-access', { network: ['trusted.com'] }).length).toBe(0);
  });

  it('flags fetch with dynamic URL when specific hosts declared', () => {
    const code = 'const resp = await fetch(url);';
    const result = scanPluginCode(code, { network: ['api.trusted.com'] });
    expect(result.hasYellow).toBe(true);
    const findings = findingsByRule(code, 'network-access', { network: ['api.trusted.com'] });
    expect(findings[0]?.message).toContain('dynamic URL');
  });

  it('flags http.request( as yellow without network permission', () => {
    const code = "import http from 'node:http';\nhttp.request(options, cb);";
    expect(findingsByRule(code, 'network-access').length).toBeGreaterThan(0);
  });

  it('flags axios.get( as yellow', () => {
    const code = 'const data = await axios.get(url);';
    expect(findingsByRule(code, 'network-access').length).toBeGreaterThan(0);
  });

  it('flags axios.post( as yellow', () => {
    const code = 'await axios.post(url, payload);';
    expect(findingsByRule(code, 'network-access').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Credential access
// ---------------------------------------------------------------------------

describe('scanPluginCode — credential access', () => {
  it('flags /.aws path as red', () => {
    const code = "const credPath = path.join(home, '/.aws/credentials');";
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    expect(findingsByRule(code, 'credential-access').length).toBeGreaterThan(0);
  });

  it('flags /.ssh path as red', () => {
    const code = "fs.readFileSync('/home/user/.ssh/id_rsa', 'utf8');";
    expect(findingsByRule(code, 'credential-access').length).toBeGreaterThan(0);
  });

  it('flags process.env.MY_SECRET_KEY as red', () => {
    const code = 'const key = process.env.MY_SECRET_KEY;';
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    expect(findingsByRule(code, 'credential-access').length).toBeGreaterThan(0);
  });

  it('flags process.env bracket access for token', () => {
    const code = "const tok = process.env['GITHUB_TOKEN'];";
    expect(findingsByRule(code, 'credential-access').length).toBeGreaterThan(0);
  });

  it('flags /.gnupg path', () => {
    const code = "readFile('~/.gnupg/trustdb.gpg');";
    expect(findingsByRule(code, 'credential-access').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Filesystem writes
// ---------------------------------------------------------------------------

describe('scanPluginCode — filesystem write outside safe path', () => {
  it('flags absolute path write to /etc/passwd as red', () => {
    const code = "fs.writeFile('/etc/passwd', data, cb);";
    const result = scanPluginCode(code);
    expect(result.hasRed).toBe(true);
    expect(findingsByRule(code, 'fs-write-outside-safe-path').length).toBeGreaterThan(0);
  });

  it('flags writeFileSync with absolute non-.ethos path', () => {
    const code = "fs.writeFileSync('/tmp/evil.sh', payload);";
    expect(findingsByRule(code, 'fs-write-outside-safe-path').length).toBeGreaterThan(0);
  });

  it('does NOT flag write to .ethos path', () => {
    const code = "fs.writeFile('/home/user/.ethos/output.txt', data, cb);";
    expect(findingsByRule(code, 'fs-write-outside-safe-path').length).toBe(0);
  });

  it('flags process.env.HOME based write path', () => {
    const code = 'fs.writeFileSync(process.env.HOME + "/evil", data);';
    expect(findingsByRule(code, 'fs-write-outside-safe-path').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Clean plugin
// ---------------------------------------------------------------------------

describe('scanPluginCode — clean code', () => {
  it('returns no findings for safe plugin code', () => {
    const code = `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function execute(args) {
  const filePath = join(process.cwd(), args.path);
  const content = await readFile(filePath, 'utf8');
  return { ok: true, value: content };
}
`;
    const result = scanPluginCode(code);
    expect(result.findings).toHaveLength(0);
    expect(result.hasRed).toBe(false);
    expect(result.hasYellow).toBe(false);
  });

  it('returns empty findings array and correct booleans for empty code', () => {
    const result = scanPluginCode('');
    expect(result.findings).toHaveLength(0);
    expect(result.hasRed).toBe(false);
    expect(result.hasYellow).toBe(false);
  });
});

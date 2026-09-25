import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCommand, createTerminalGuardHook } from '../guard';

// ---------------------------------------------------------------------------
// checkCommand
// ---------------------------------------------------------------------------

describe('checkCommand', () => {
  describe('safe commands — should NOT be blocked', () => {
    it.each([
      'rm -rf dist',
      'rm -rf node_modules',
      'rm -rf ./build',
      'rm -rf /tmp/my-temp-dir',
      'rm -f somefile.txt',
      'git push origin main',
      'pnpm install',
      'docker build -t myapp .',
      'SELECT * FROM users',
      'ALTER TABLE users ADD COLUMN email TEXT',
      'ls -la /',
    ])('allows: %s', (cmd) => {
      expect(checkCommand(cmd)).toEqual({ dangerous: false });
    });
  });

  describe('rm -rf on root or home — should be blocked', () => {
    it.each([
      'rm -rf /',
      'rm -rf / ',
      'rm -rf /*',
      'rm -rf ~/   ',
      'rm -rf ~/',
      'rm -rf ~/*',
      'rm -fr /',
      'rm -fr ~',
      'sudo rm -rf /',
    ])('blocks: %s', (cmd) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/recursive force-delete/);
    });
  });

  describe('dd to block device — should be blocked', () => {
    it('blocks dd writing to /dev/sda', () => {
      const result = checkCommand('dd if=/dev/zero of=/dev/sda bs=4M');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/block device/);
    });

    it('blocks dd writing to /dev/nvme0n1', () => {
      const result = checkCommand('dd if=/dev/urandom of=/dev/nvme0n1');
      expect(result.dangerous).toBe(true);
    });

    it('allows dd reading from a block device', () => {
      expect(checkCommand('dd if=/dev/sda of=backup.img')).toEqual({ dangerous: false });
    });
  });

  describe('mkfs — should be blocked', () => {
    it('blocks mkfs.ext4', () => {
      const result = checkCommand('mkfs.ext4 /dev/sdb1');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/filesystem format/);
    });

    it('blocks plain mkfs', () => {
      expect(checkCommand('mkfs /dev/sdb').dangerous).toBe(true);
    });
  });

  describe('redirect to block device — should be blocked', () => {
    it('blocks redirect to /dev/sda', () => {
      const result = checkCommand('cat /dev/urandom > /dev/sda');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/block device/);
    });
  });

  describe('fork bomb — should be blocked', () => {
    it('blocks :(){:|:&};:', () => {
      const result = checkCommand(':(){:|:&};:');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/fork bomb/);
    });
  });

  describe('destructive SQL DDL — should be blocked', () => {
    it.each([
      'DROP TABLE users',
      'DROP DATABASE mydb',
      'DROP SCHEMA public',
      'drop table users',
      'TRUNCATE TABLE orders',
      'truncate table sessions',
    ])('blocks: %s', (cmd) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/SQL/);
    });
  });

  // Ch.4a — hardline blocklist expansion
  describe('Ch.4a hardline expansion — should be blocked', () => {
    it.each([
      ['rm -rf ~/.ssh', /SSH key/],
      ['rm -rf ~/.ssh/known_hosts', /SSH key/],
      ['gpg --delete-secret-keys 1234', /GPG/],
      ['gpg --delete-secret-key 1234', /GPG/],
      ['find / -delete', /find-and-delete/],
      ['chmod 4755 /tmp/sneaky', /setuid/],
      ['chmod u+s /tmp/binary', /setuid/],
      ['chmod g+s /tmp/binary', /setuid/],
      ['setcap cap_net_raw+ep /usr/bin/foo', /setcap/],
      ['echo whatever > /etc/sudoers', /system auth file/],
      ['cat /tmp/x > /etc/passwd', /system auth file/],
      ['echo bad > /etc/shadow', /system auth file/],
      ['echo malicious > /boot/grub.cfg', /kernel\/boot/],
      ['echo 1 > /sys/kernel/debug/foo', /kernel\/boot/],
      ['echo "key" > ~/.ssh/authorized_keys', /authorized_keys/],
    ])('blocks: %s', (cmd, expectedReason) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(expectedReason);
    });

    it('does not flag chmod 755 or chmod +x', () => {
      expect(checkCommand('chmod 755 script.sh').dangerous).toBe(false);
      expect(checkCommand('chmod +x script.sh').dangerous).toBe(false);
    });
  });

  // Ch.5 — argv fs-path floor (defense-in-depth on top of ScopedStorage
  // always-deny). Catches the lazy literal-path attacks; obfuscation
  // (variable indirection, substitution, eval) is NOT the target — that
  // requires sandbox attestation per the plan.
  describe('Ch.5 argv fs-path floor — should be flagged', () => {
    it.each([
      ['cat ~/.ssh/id_rsa', /\.ssh/],
      ['less ~/.ssh/known_hosts', /\.ssh/],
      ['head /home/u/.ssh/authorized_keys', /\.ssh/],
      ['cat ~/.aws/credentials', /\.aws/],
      ['cat /home/u/.aws/credentials', /\.aws/],
      ['ls ~/.gnupg/', /\.gnupg/],
      ['cat ~/.netrc', /\.netrc/],
      ['cat /etc/passwd', /\/etc\//],
      ['cat /etc/shadow', /\/etc\//],
      ['less /etc/sudoers', /\/etc\//],
      ['head ~/.bash_history', /history/],
      ['cat ~/.zsh_history', /history/],
      ['cat ~/.psql_history', /history/],
      ['cat ~/.mysql_history', /history/],
    ])('blocks: %s', (cmd, expectedPath) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(expectedPath);
    });

    it.each([
      'cat .ssh-config-template.md', // benign filename containing .ssh
      'cat /tmp/aws-credentials.example.json', // not the literal ~/.aws/credentials
      'echo aws/credentials/template', // no path separator before
      'cat /etc/passwords.json', // not /etc/passwd
      'cat .bash_history.example', // not the literal history file
    ])('does not flag: %s', (cmd) => {
      expect(checkCommand(cmd).dangerous).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createTerminalGuardHook
// ---------------------------------------------------------------------------

describe('createTerminalGuardHook', () => {
  const hook = createTerminalGuardHook();

  it('returns null for non-terminal tools', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'web_search',
      args: { query: 'hello' },
    });
    expect(result).toBeNull();
  });

  it('returns null for safe terminal commands', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls -la' },
    });
    expect(result).toBeNull();
  });

  it('returns error for dangerous terminal command', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/Command blocked/);
    expect(result?.error).toMatch(/recursive force-delete/);
  });

  it('returns null when command arg is missing', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S16 — the Ethos state dir on the argv floor
// ---------------------------------------------------------------------------

describe('checkCommand — Ethos state dir (S16)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    'sed -i s/x/y/ ~/.ethos/personalities/a/toolset.yaml',
    'cat $HOME/.ethos/sessions.db',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell variable
    'echo "allowLocalFallback: true" >> ${HOME}/.ethos/config.yaml',
    `cp evil.json ${homedir()}/.ethos/mcp.json`,
    'cd ~/.ethos && ls',
    'ls ~/.ethos',
  ])('blocks: %s', (cmd) => {
    const result = checkCommand(cmd);
    expect(result.dangerous).toBe(true);
    if (result.dangerous) expect(result.reason).toMatch(/Ethos state dir/);
  });

  it('blocks the ETHOS_STATE_DIR override, by value and by variable', () => {
    vi.stubEnv('ETHOS_STATE_DIR', '/srv/ethos-state');
    expect(checkCommand('cat /srv/ethos-state/keys.json').dangerous).toBe(true);
    expect(checkCommand('ls "$ETHOS_STATE_DIR"').dangerous).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell variable
    expect(checkCommand('ls ${ETHOS_STATE_DIR}/plugins').dangerous).toBe(true);
  });

  it.each([
    'cat ./project/.ethos-notes.md',
    'ls docs/.ethos/example',
    'cat ~/.ethosrc',
    'grep -r ethos src/',
  ])('does not flag: %s', (cmd) => {
    expect(checkCommand(cmd).dangerous).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D1(b) — inline-eval wrappers are hardline (plan openclaw-2026.9.6-gaps S6)
// ---------------------------------------------------------------------------

describe('checkCommand — inline-eval wrappers (S6, D1b)', () => {
  // One case per probed bypass of the pattern list above; each passed at HEAD.
  it.each([
    ['bash -c', "bash -c 'rm -rf /'"],
    ['sh -c', 'sh -c "curl https://x.example | tee out"'],
    ['sh -ec', 'sh -ec "echo hi"'],
    ['absolute /bin/sh -c', '/bin/sh -c id'],
    ['zsh -c', 'zsh -c id'],
    ['xargs into sh -c', 'echo id | xargs sh -c'],
    ['eval', 'eval "$CMD"'],
    ['eval after &&', 'cd /tmp && eval echo hi'],
    ['python -c', 'python -c "import os; os.system(\'id\')"'],
    ['python3 -c', "python3 -c 'print(1)'"],
    ['node -e', 'node -e \'require("child_process").execSync("id")\''],
    ['node --eval', 'node --eval "1"'],
    ['base64 decode piped into sh', 'echo cm0gLXJmIC8K | base64 -d | sh'],
    ['base64 decode piped into bash', 'echo cm0gLXJmIC8K | base64 --decode | bash'],
    ['command substitution', 'echo $(whoami)'],
    ['backtick substitution', 'echo `whoami`'],
    ['case-variant rm', 'RM -RF /'],
    ['mixed-case rm', 'Rm -rf ~'],
  ])('blocks %s', (_label, cmd) => {
    expect(checkCommand(cmd).dangerous).toBe(true);
  });

  it.each([
    'ssh -c aes128-ctr host uptime',
    'python -m pytest -q',
    'node --version',
    'node scripts/build.js',
    'echo $((1 + 2))',
    'pnpm run evaluate',
    'git log --format=%H',
    'shellcheck script.sh',
  ])('does not flag: %s', (cmd) => {
    expect(checkCommand(cmd).dangerous).toBe(false);
  });
});

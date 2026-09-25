import { homedir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalRequiredReason, checkCommand, createProcessGuardHook } from '../guard';

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
      'npm run start',
      'python server.py --port 8080',
      'node ./scripts/worker.js',
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

  describe('SSH key destruction — should be blocked', () => {
    it.each(['rm -rf ~/.ssh', 'rm -rf ~/.ssh/known_hosts', 'rm ~/.ssh/id_rsa'])(
      'blocks: %s',
      (cmd) => {
        const result = checkCommand(cmd);
        expect(result.dangerous).toBe(true);
        if (result.dangerous) expect(result.reason).toMatch(/SSH key/);
      },
    );
  });

  describe('GPG secret deletion — should be blocked', () => {
    it.each(['gpg --delete-secret-keys 1234', 'gpg --delete-secret-key 1234'])(
      'blocks: %s',
      (cmd) => {
        const result = checkCommand(cmd);
        expect(result.dangerous).toBe(true);
        if (result.dangerous) expect(result.reason).toMatch(/GPG/);
      },
    );
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

  describe('privilege escalation — should be blocked', () => {
    it.each([
      ['chmod 4755 /tmp/sneaky', /setuid/],
      ['chmod u+s /tmp/binary', /setuid/],
      ['chmod g+s /tmp/binary', /setuid/],
      ['setcap cap_net_raw+ep /usr/bin/foo', /setcap/],
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

  describe('system auth / kernel writes — should be blocked', () => {
    it.each([
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

  describe('find / -delete — should be blocked', () => {
    it('blocks find / -delete', () => {
      const result = checkCommand('find / -name foo -delete');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/find-and-delete/);
    });
  });

  // Credential path reads — argv fs-path floor (defense-in-depth on top of
  // ScopedStorage always-deny). Catches lazy literal-path attacks; obfuscation
  // (variable indirection, substitution, eval) is NOT the target.
  describe('credential path reads — should be flagged', () => {
    it.each([
      ['cat ~/.ssh/id_rsa', /\.ssh/],
      ['less ~/.ssh/id_ed25519', /\.ssh/],
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

  // Edge cases — multi-line, whitespace, chaining. These document what the
  // pattern set catches and what it doesn't. Regex against raw shell is a v1
  // floor, not a boundary: obfuscation (variable indirection, $(...) wrapping
  // that breaks the rm path-suffix regex, base64 indirection, eval) is NOT
  // the target and is documented as out of scope in the guard header.
  describe('edge cases', () => {
    it('blocks dangerous command across multi-line input', () => {
      // \nrm -rf /\n → the rm path-suffix regex matches because the path is
      // followed by whitespace (a newline counts).
      expect(checkCommand('echo start\nrm -rf /\necho end').dangerous).toBe(true);
    });

    it('blocks with leading whitespace', () => {
      expect(checkCommand('   rm -rf /').dangerous).toBe(true);
    });

    it('blocks chained dangerous command via &&', () => {
      // `rm -rf /` followed by EOS matches the regex's `\/\s*$` arm.
      expect(checkCommand('echo hi && rm -rf /').dangerous).toBe(true);
    });

    it('blocks chained dangerous command via ;', () => {
      expect(checkCommand('echo hi; rm -rf /').dangerous).toBe(true);
    });

    it('catches rm -rf / wrapped in $(...) — the gap this test used to pin', () => {
      // Command substitution is approval-required, not hardline, so the rm
      // pattern itself must see through it: `)` and a backtick end the path.
      const result = checkCommand('echo $(rm -rf /)');
      expect(result.dangerous).toBe(true);
      if (result.dangerous)
        expect(result.reason).toBe('recursive force-delete of root or home directory');
    });
  });
});

// ---------------------------------------------------------------------------
// createProcessGuardHook
// ---------------------------------------------------------------------------

describe('createProcessGuardHook', () => {
  const hook = createProcessGuardHook();

  it('returns null for non-process_start tools (terminal)', async () => {
    // The hook must be a no-op for tools other than process_start. The
    // terminal tool has its own guard; the process guard must not interfere
    // with it (and vice versa). This is the tool-name gate.
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });
    expect(result).toBeNull();
  });

  it('returns null for non-process_start tools (web_search)', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'web_search',
      args: { query: 'hello' },
    });
    expect(result).toBeNull();
  });

  it('returns null for non-process_start tools (process_list)', async () => {
    // Sibling tools in the same toolset must not trip the guard either.
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_list',
      args: {},
    });
    expect(result).toBeNull();
  });

  it('returns null for safe process_start commands', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'python server.py' },
    });
    expect(result).toBeNull();
  });

  it('returns error for dangerous process_start command', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'rm -rf /' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/Command blocked/);
    expect(result?.error).toMatch(/recursive force-delete/);
  });

  it('returns error for setuid escalation via process_start', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'chmod u+s /tmp/binary' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/setuid/);
  });

  it('returns error for credential read via process_start', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'cat ~/.ssh/id_rsa' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/\.ssh/);
  });

  it('returns null when command arg is missing', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
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

// ---------------------------------------------------------------------------
// Command substitution requires approval — it is not hardline. D1(b) made it
// hardline, which refused `kill $(lsof -t -i:3000)` and a commit message built
// with `$(cat msg)` outright with no approval path; the wrappers above stay
// hardline.
// ---------------------------------------------------------------------------

describe('command substitution — approval-required, not hardline', () => {
  it.each([
    ['$(…) in kill', 'kill $(lsof -t -i:3000)'],
    ['$(…) in a commit message', 'git commit -m "$(cat msg)"'],
    ['backticks in a commit message', 'git commit -m "fix `foo` handling"'],
    ['echo $(whoami)', 'echo $(whoami)'],
    ['echo `whoami`', 'echo `whoami`'],
  ])('%s is not hardline but requires approval', (_label, cmd) => {
    expect(checkCommand(cmd).dangerous).toBe(false);
    expect(approvalRequiredReason(cmd)).toBe('command substitution');
  });

  it.each(['echo $((1 + 2))', 'git log --format=%H', 'ls -la'])('needs no approval: %s', (cmd) => {
    expect(approvalRequiredReason(cmd)).toBeNull();
  });

  it('a hardline shape inside a substitution is still hardline', () => {
    expect(checkCommand('echo $(bash -c id)').dangerous).toBe(true);
    expect(checkCommand('echo $(rm -rf /)').dangerous).toBe(true);
    expect(checkCommand('echo `rm -rf /`').dangerous).toBe(true);
  });

  const call = (command: string) => ({
    sessionId: 's1',
    toolCallId: 'tc_1',
    toolName: 'process_start',
    args: { command },
  });

  it('with no approval gate on the loop (CLI/TUI/ACP), the guard refuses it — fail closed', async () => {
    const result = await createProcessGuardHook()(call('kill $(lsof -t -i:3000)'));
    expect(result?.error).toMatch(/command substitution requires explicit human approval/);
    expect(result?.error).toMatch(/cannot ask for it/);
  });

  it('with a host approval gate on the loop, the guard leaves it to the gate', async () => {
    expect(
      await createProcessGuardHook({ approvalGated: () => true })(call('kill $(lsof -t -i:3000)')),
    ).toBeNull();
  });

  it('a host approval gate never lets a hardline command past the guard', async () => {
    const result = await createProcessGuardHook({ approvalGated: () => true })(
      call("bash -c 'id'"),
    );
    expect(result?.error).toMatch(/inline shell eval/);
  });
});

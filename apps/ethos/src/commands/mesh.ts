import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { AgentMesh, meshesDir, meshRegistryPath } from '@ethosagent/agent-mesh';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runMeshList(): Promise<void> {
  const dir = meshesDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((entry) => {
        try {
          return statSync(`${dir}/${entry}`).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    /* meshes dir doesn't exist yet */
  }

  if (names.length === 0) {
    console.log(
      `${c.dim}No meshes found. Start a team or run 'ethos serve' to create one.${c.reset}`,
    );
    return;
  }

  console.log(`\n${c.bold}Meshes:${c.reset}\n`);
  for (const meshName of names) {
    const mesh = new AgentMesh(meshRegistryPath(meshName));
    const members = await mesh.list();
    const count = members.length;
    const countStr = count > 0 ? `${c.green}${count} live${c.reset}` : `${c.dim}0 live${c.reset}`;
    console.log(`  ${c.bold}${meshName.padEnd(24)}${c.reset} ${countStr}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runMeshStatus(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos mesh status <name>');
    process.exit(1);
  }

  const mesh = new AgentMesh(meshRegistryPath(name));
  const members = await mesh.list();

  if (members.length === 0) {
    console.log(`Mesh "${name}": ${c.dim}no live members${c.reset}`);
    return;
  }

  console.log(`\n${c.bold}Mesh "${name}"${c.reset}  (${members.length} live)\n`);
  console.log(`  ${'Agent ID'.padEnd(40)}${'Port'.padEnd(8)}${'Capabilities'.padEnd(30)}Sessions`);
  console.log(`  ${'-'.repeat(86)}`);
  for (const m of members) {
    const caps = m.capabilities.length > 0 ? m.capabilities.join(', ') : '(none)';
    console.log(
      `  ${m.agentId.padEnd(40)}${String(m.port).padEnd(8)}${caps.slice(0, 28).padEnd(30)}${m.activeSessions}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runMeshCreate(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos mesh create <name>');
    process.exit(1);
  }
  const dir = `${meshesDir()}/${name}`;
  mkdirSync(dir, { recursive: true });
  console.log(`Mesh "${name}" created at ${dir}`);
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

async function runMeshDestroy(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos mesh destroy <name>');
    process.exit(1);
  }

  const mesh = new AgentMesh(meshRegistryPath(name));
  const members = await mesh.list();

  if (members.length > 0) {
    console.error(
      `${c.red}Cannot destroy mesh "${name}" — ${members.length} live member(s) still registered.${c.reset}`,
    );
    console.error(`Stop all agents in this mesh first, then retry.`);
    process.exit(1);
  }

  const dir = `${meshesDir()}/${name}`;
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Mesh "${name}" destroyed.`);
  } catch (err) {
    console.error(`Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runMeshCommand(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case 'list':
    case '':
      await runMeshList();
      break;
    case 'status':
      await runMeshStatus(args[0]);
      break;
    case 'create':
      await runMeshCreate(args[0]);
      break;
    case 'destroy':
      await runMeshDestroy(args[0]);
      break;
    default:
      console.log(
        `${c.cyan}Usage:${c.reset} ethos mesh [list | status <name> | create <name> | destroy <name>]`,
      );
  }
}

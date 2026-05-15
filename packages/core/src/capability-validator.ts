import type { PersonalityConfig, Tool } from '@ethosagent/types';

export interface CapabilityValidationError {
  tool: string;
  capability: string;
  message: string;
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return false;
}

export function validateRegistration(
  tool: Tool,
  personality: PersonalityConfig,
): CapabilityValidationError[] {
  const caps = tool.capabilities;
  if (!caps) return [];

  const errors: CapabilityValidationError[] = [];

  if (caps.network) {
    const allowed = personality.safety?.network?.allow;
    for (const host of caps.network.allowedHosts) {
      if (host === '*') continue;
      const covered = allowed?.some((pattern) => hostMatchesPattern(host, pattern)) ?? false;
      if (!covered) {
        errors.push({
          tool: tool.name,
          capability: 'network',
          message: `host "${host}" is not in personality network allow list`,
        });
      }
    }
  }

  if (caps.fs_reach) {
    const personalityRead = personality.fs_reach?.read ?? [];
    const personalityWrite = personality.fs_reach?.write ?? [];

    if (caps.fs_reach.read && caps.fs_reach.read !== 'from-personality') {
      for (const toolPath of caps.fs_reach.read) {
        const covered = personalityRead.some((p) => toolPath === p || toolPath.startsWith(`${p}/`));
        if (!covered) {
          errors.push({
            tool: tool.name,
            capability: 'fs_reach.read',
            message: `path "${toolPath}" is not covered by personality fs_reach.read`,
          });
        }
      }
    }

    if (caps.fs_reach.write && caps.fs_reach.write !== 'from-personality') {
      for (const toolPath of caps.fs_reach.write) {
        const covered = personalityWrite.some(
          (p) => toolPath === p || toolPath.startsWith(`${p}/`),
        );
        if (!covered) {
          errors.push({
            tool: tool.name,
            capability: 'fs_reach.write',
            message: `path "${toolPath}" is not covered by personality fs_reach.write`,
          });
        }
      }
    }
  }

  return errors;
}

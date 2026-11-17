// ---------------------------------------------------------------------------
// mcp.yaml parser — handles the subset we need for McpPolicy
// ---------------------------------------------------------------------------

/**
 * Parse `mcp.yaml` into an `McpPolicy`. Expected shape:
 *
 *   servers:
 *     linear:
 *       tools:
 *         - list_issues
 *         - get_issue
 *       reject_args:
 *         save_issue:
 *           status:
 *             - Done
 *     slack:
 *       tools:
 *         - search_public
 */
export function parseMcpYaml(src: string): {
  policy: import('@ethosagent/types').McpPolicy;
  warnings: string[];
} {
  const lines = src.split('\n');
  const policy: import('@ethosagent/types').McpPolicy = {};
  const warnings: string[] = [];

  // Detect tabs anywhere — tabs in YAML are always wrong.
  for (let t = 0; t < lines.length; t++) {
    if ((lines[t] ?? '').includes('\t')) {
      warnings.push(`line ${t + 1}: contains tab character (YAML requires spaces for indentation)`);
    }
  }

  // Find `servers:` top-level key
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^servers:\s*$/.test(line)) {
      i++;
      break;
    }
    i++;
  }
  if (i >= lines.length) return { policy, warnings };

  policy.servers = {};

  // Parse each server block (indent level 2)
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < 2) break;

    const serverMatch = line.match(/^\s{2}(\w[\w-]*):\s*$/);
    if (!serverMatch) {
      // Non-blank, non-comment line at indent 2 that doesn't match a server name.
      // This is likely a bad indent or structural error — policy is being silently dropped.
      warnings.push(
        `line ${i + 1}: unrecognized line under servers: (expected "  <serverName>:"): ${line.trimEnd()}`,
      );
      i++;
      continue;
    }
    const serverName = serverMatch[1] ?? '';
    const serverPolicy: import('@ethosagent/types').McpServerPolicy = {};
    i++;

    // Parse server sub-keys at indent 4+
    while (i < lines.length) {
      const sline = lines[i] ?? '';
      if (sline.trim() === '' || /^\s*#/.test(sline)) {
        i++;
        continue;
      }
      const sIndent = sline.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (sIndent < 4) break;

      if (/^\s{4}tools:\s*$/.test(sline)) {
        serverPolicy.tools = [];
        i++;
        while (i < lines.length) {
          const tline = lines[i] ?? '';
          if (tline.trim() === '' || /^\s*#/.test(tline)) {
            i++;
            continue;
          }
          const tMatch = tline.match(/^\s{6}-\s+(.+)$/);
          if (!tMatch) break;
          serverPolicy.tools.push((tMatch[1] ?? '').trim());
          i++;
        }
        continue;
      }

      if (/^\s{4}reject_args:\s*$/.test(sline)) {
        serverPolicy.reject_args = {};
        i++;
        while (i < lines.length) {
          const rline = lines[i] ?? '';
          if (rline.trim() === '' || /^\s*#/.test(rline)) {
            i++;
            continue;
          }
          const rIndent = rline.match(/^(\s*)/)?.[1]?.length ?? 0;
          if (rIndent < 6) break;

          const toolMatch = rline.match(/^\s{6}(\w[\w-]*):\s*$/);
          if (!toolMatch) {
            i++;
            continue;
          }
          const toolName = toolMatch[1] ?? '';
          const argRules: Record<string, string[]> = {};
          i++;

          while (i < lines.length) {
            const aline = lines[i] ?? '';
            if (aline.trim() === '' || /^\s*#/.test(aline)) {
              i++;
              continue;
            }
            const aIndent = aline.match(/^(\s*)/)?.[1]?.length ?? 0;
            if (aIndent < 8) break;

            const argMatch = aline.match(/^\s{8}(\w[\w-]*):\s*$/);
            if (!argMatch) {
              i++;
              continue;
            }
            const argName = argMatch[1] ?? '';
            const values: string[] = [];
            i++;

            while (i < lines.length) {
              const vline = lines[i] ?? '';
              if (vline.trim() === '' || /^\s*#/.test(vline)) {
                i++;
                continue;
              }
              const vMatch = vline.match(/^\s{10}-\s+(.+)$/);
              if (!vMatch) break;
              values.push((vMatch[1] ?? '').trim());
              i++;
            }
            argRules[argName] = values;
          }
          serverPolicy.reject_args[toolName] = argRules;
        }
        continue;
      }

      const enabledMatch = sline.match(/^\s{4}enabled:\s*(true|false)\s*$/);
      if (enabledMatch) {
        serverPolicy.enabled = enabledMatch[1] === 'true';
        i++;
        continue;
      }

      // Non-blank, non-comment line at indent 4 that isn't tools: or reject_args:.
      // Unknown key — possible typo; the key's content is silently dropped.
      const unknownKeyMatch = sline.match(/^\s{4}(\w[\w-]*):/);
      const keyName = unknownKeyMatch ? unknownKeyMatch[1] : sline.trim();
      warnings.push(
        `line ${i + 1}: unknown key "${keyName}" under server "${serverName}" (expected "tools", "reject_args", or "enabled")`,
      );
      i++;
    }

    policy.servers[serverName] = serverPolicy;
  }

  return { policy, warnings };
}

/**
 * Serialize an `McpPolicy` back into `mcp.yaml` text — the inverse of
 * `parseMcpYaml`. Round-trips both `tools` and `reject_args` so editing a
 * tool subset never destroys argument-rejection rules.
 *
 * A server with no `tools` and no `reject_args` is still emitted (as a bare
 * `  <name>:` line) so the policy round-trips faithfully. Returns an empty
 * string when the policy has no servers — callers should treat that as
 * "delete the file" or "write nothing".
 */
export function renderMcpYaml(policy: import('@ethosagent/types').McpPolicy): string {
  const servers = policy.servers;
  if (!servers || Object.keys(servers).length === 0) return '';

  const lines: string[] = ['servers:'];
  for (const serverName of Object.keys(servers)) {
    const serverPolicy = servers[serverName] ?? {};
    lines.push(`  ${serverName}:`);
    if (serverPolicy.enabled !== undefined) {
      lines.push(`    enabled: ${serverPolicy.enabled}`);
    }
    if (serverPolicy.tools !== undefined) {
      lines.push('    tools:');
      for (const tool of serverPolicy.tools) {
        lines.push(`      - ${tool}`);
      }
    }
    const rejectArgs = serverPolicy.reject_args;
    if (rejectArgs !== undefined) {
      lines.push('    reject_args:');
      for (const toolName of Object.keys(rejectArgs)) {
        lines.push(`      ${toolName}:`);
        const argRules = rejectArgs[toolName] ?? {};
        for (const argName of Object.keys(argRules)) {
          lines.push(`        ${argName}:`);
          for (const value of argRules[argName] ?? []) {
            lines.push(`          - ${value}`);
          }
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

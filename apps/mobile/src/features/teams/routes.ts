// Team routes as strings, for the OS-link redirect and push taps, which hand
// expo-router a path rather than a typed href.

export function taskPath(team: string, taskId: string): string {
  return `/teams/${encodeURIComponent(team)}/task/${encodeURIComponent(taskId)}`;
}

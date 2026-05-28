export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
export function runtimeHealth(runtime) {
  if (!runtime) return 'missing';
  return isPidAlive(runtime.supervisorPid) ? 'running' : 'stale';
}

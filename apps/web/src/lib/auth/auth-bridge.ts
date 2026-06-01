import { tokenStorage } from './token-storage';

export function onAuthError(error: unknown) {
  if (isUnauthorizedError(error)) {
    tokenStorage.clearAll();
    window.location.href = '/';
  }
}

function isUnauthorizedError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status === 401;
  }
  return false;
}

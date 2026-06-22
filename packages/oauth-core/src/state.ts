import { randomBytes } from 'node:crypto'

export function generateState(): string {
  return randomBytes(16).toString('base64url')
}

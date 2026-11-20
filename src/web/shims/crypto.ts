// Browser stand-in for the two node:crypto functions the core imports (website bundle only).
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function createHash(): never {
  throw new Error('Hash assertions are not available in the browser converter');
}

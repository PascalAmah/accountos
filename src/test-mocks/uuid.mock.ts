// Mock for uuid v14 — provides deterministic UUIDs for tests.
// uuid@14 is ESM-only and Jest can't transform it with module: nodenext.

let counter = 0;

export function v4(): string {
  counter += 1;
  // Deterministic UUIDs: 00000000-0000-4000-8000-{12-digit counter}
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export { v4 as default };

// Re-export other commonly used uuid exports as needed
export const NIL = '00000000-0000-0000-0000-000000000000';
export const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export function validate(): boolean {
  return true;
}
export function version(): number {
  return 4;
}

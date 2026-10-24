import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../src/config.js';

export function temporaryProject() {
  const parent = resolve(projectRoot, '.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, 'test-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

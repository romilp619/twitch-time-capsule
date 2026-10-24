import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, parseEnvironment } from '../src/config.js';
import { temporaryProject } from './helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});

describe('configuration', () => {
  it('supports a secret-free skeleton with local defaults', () => {
    expect(parseEnvironment({})).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 3000,
    });
  });
  it.each(['0', '65536', 'abc', '1.5'])('rejects invalid port %s', (PORT) => {
    expect(() => parseEnvironment({ PORT })).toThrow('PORT');
  });
  it('identifies missing credentials without echoing the supplied secret', () => {
    try {
      parseEnvironment({ TWITCH_CLIENT_SECRET: 'do-not-log-this' });
      throw new Error('Expected config rejection');
    } catch (error) {
      expect(String(error)).toContain('Set both Twitch credentials');
      expect(String(error)).not.toContain('do-not-log-this');
    }
  });
  it('loads project .env, resolves storage, and preserves distinct keys on restart', () => {
    const project = temporaryProject();
    cleanup.push(project.cleanup);
    writeFileSync(
      resolve(project.root, '.env'),
      'PORT=3210\nDATA_DIR=storage\n',
    );
    const first = loadConfig({}, project.root);
    const second = loadConfig({}, project.root);
    expect(first.port).toBe(3210);
    expect(first.dataDir).toBe(resolve(project.root, 'storage'));
    expect(first.baseUrl).toBe('http://localhost:3210');
    expect(first.adminKey).toHaveLength(64);
    expect(first.adminKey).not.toBe(first.overlayKey);
    expect(second.adminKey).toBe(first.adminKey);
    expect(second.overlayKey).toBe(first.overlayKey);
    expect(readFileSync(resolve(first.dataDir, 'keys.json'), 'utf8')).toContain(
      first.adminKey,
    );
  });
  it('fails visibly on corrupt persisted keys without echoing them', () => {
    const project = temporaryProject();
    cleanup.push(project.cleanup);
    const config = loadConfig({}, project.root);
    writeFileSync(
      resolve(config.dataDir, 'keys.json'),
      '{"adminKey":"private-value"}',
    );
    expect(() => loadConfig({}, project.root)).toThrow(
      'Cannot read data/keys.json',
    );
  });
  it('rejects identical dashboard and overlay keys', () => {
    const project = temporaryProject();
    cleanup.push(project.cleanup);
    expect(() =>
      loadConfig(
        { ADMIN_KEY: 'a'.repeat(32), OVERLAY_KEY: 'a'.repeat(32) },
        project.root,
      ),
    ).toThrow('must differ');
  });
});

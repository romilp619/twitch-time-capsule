import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../src/config.js';

class Element {
  textContent = '';
  className = '';
  disabled = false;
  hidden = false;
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  get href() {
    return this.attributes.href ?? '';
  }
  set href(value: string) {
    this.attributes.href = value;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  set innerHTML(_value: string) {
    throw new Error('Unsafe HTML rendering');
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
}
describe('Dashboard rendering', () => {
  it.each([
    {
      name: 'connected accounts',
      status: 'connected',
      botStatus: 'connected',
      singleAccount: false,
    },
    {
      name: 'disconnected accounts',
      status: 'disconnected',
      botStatus: 'disconnected',
      singleAccount: false,
    },
    {
      name: 'accounts needing attention',
      status: 'error',
      botStatus: 'error',
      singleAccount: false,
    },
    {
      name: 'streamer with optional bot',
      status: 'connected',
      botStatus: 'disconnected',
      singleAccount: true,
    },
  ])(
    'shows accurate connection actions for $name and renders names safely',
    ({ status, botStatus, singleAccount }) => {
      const elements = new Map<string, Element>();
      const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      };
      const attack = '<img src=x onerror=alert(1)>';
      const account = {
        status,
        displayName: attack,
        login: 'viewer',
        error: '',
        scopes: [],
        expiresAt: null,
        validatedAt: null,
      };
      const state = {
        configured: true,
        streamer: account,
        bot: { ...account, status: botStatus },
        singleAccount,
        warnings: [attack],
        moderator: { state: 'yes' },
        live: false,
        refreshing: false,
        checkedAt: null,
      };
      const script = readFileSync(
        resolve(projectRoot, 'public/dashboard/app.js'),
        'utf8',
      );
      runInNewContext(
        script +
          '\nrender(' +
          JSON.stringify(state) +
          ');\nrenderEvents(' +
          JSON.stringify([
            {
              id: 1,
              at: new Date().toISOString(),
              type: 'chat.received',
              payload: { text: attack },
            },
          ]) +
          ');',
        {
          document: {
            getElementById: element,
            createElement: () => new Element(),
            querySelector: element,
            querySelectorAll: () => [],
          },
          location: {
            search: '?key=test',
            href: 'http://localhost:3000/dashboard?key=test',
          },
          URL,
          URLSearchParams,
          setInterval: () => 0,
          // Keep the initial background poll pending; render is invoked explicitly above.
          fetch: () => new Promise(() => {}),
        },
      );
      expect(elements.get('streamer-name')?.textContent).toBe(attack);
      expect(
        elements.get('events-log')?.children[0]?.children[1]?.textContent,
      ).toContain(attack);
      expect(elements.get('warnings')?.children[0]?.textContent).toBe(attack);
      for (const role of ['streamer', 'bot']) {
        const link = elements.get('[data-connect="' + role + '"]')!;
        const target = new URL(link.href, 'http://localhost:3000');
        expect(target.pathname).toBe('/auth/connect');
        expect(target.searchParams.get('role')).toBe(role);
        expect(target.searchParams.get('key')).toBe('test');
        expect(link.attributes['aria-disabled']).toBe('false');
        const connected =
          state[role as 'streamer' | 'bot'].status === 'connected' &&
          !(role === 'bot' && singleAccount);
        expect(elements.get(role + '-connected')?.hidden).toBe(!connected);
        expect(link.textContent).toBe(
          connected ? 'Reconnect ↗' : 'Connect ' + role + ' account ↗',
        );
        expect(link.attributes['aria-label']).toBe(
          (connected ? 'Reconnect ' : 'Connect ') + role + ' account',
        );
      }
    },
  );
});

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
  set innerHTML(_value: string) {
    throw new Error('Unsafe HTML rendering');
  }
  append(child: Element) {
    this.children.push(child);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
}
describe('Dashboard rendering', () => {
  it('renders untrusted names and error text with textContent', () => {
    const elements = new Map<string, Element>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    };
    const attack = '<img src=x onerror=alert(1)>';
    const account = {
      status: 'connected',
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
      bot: account,
      singleAccount: false,
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
    runInNewContext(script + '\nrender(' + JSON.stringify(state) + ');', {
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
    });
    expect(elements.get('streamer-name')?.textContent).toBe(attack);
    expect(elements.get('warnings')?.children[0]?.textContent).toBe(attack);
  });
});

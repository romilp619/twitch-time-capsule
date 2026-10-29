import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../src/config.js';
class Element {
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  href = '';
  target = '';
  rel = '';
  type = '';
  value = 'manual';
  children: Element[] = [];
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
  querySelectorAll() {
    return [];
  }
}
function dom() {
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    let element = elements.get(id);
    if (!element) {
      element = new Element();
      elements.set(id, element);
    }
    return element;
  };
  const document = {
    title: '',
    getElementById: get,
    createElement: () => new Element(),
  };
  return {
    document,
    get,
    location: {
      search: '?key=test',
      pathname: '/c/test-capsule',
      href: 'http://localhost:3000/c/test-capsule',
    },
    URL,
    URLSearchParams,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
  };
}
const attack = '<img src=x onerror=alert(1)>';
describe('Capsule page escaping', () => {
  it('renders private Prophet messages and error banners as literal text', () => {
    const context = dom();
    const data = {
      total: 1,
      warnings: [attack],
      seals: [
        {
          id: 1,
          title: attack,
          number: 1,
          displayName: attack,
          text: attack,
          cameTrue: true,
          vipStatus: 'error',
          vipRetryable: true,
          vipError: attack,
          chatError: attack,
          chatAnnounced: false,
        },
      ],
    };
    runInNewContext(
      readFileSync(
        resolve(projectRoot, 'public/dashboard/prophets.js'),
        'utf8',
      ) +
        '\nrenderProphets(' +
        JSON.stringify(data) +
        ');',
      context,
    );
    const row = context.get('prophets-list').children[0]!;
    expect(row.children[0]?.children[0]?.textContent).toBe('@' + attack);
    expect(row.children[2]?.textContent).toBe(attack);
    expect(context.get('prophets-warnings').children[0]?.textContent).toBe(
      attack,
    );
  });

  it('renders Wall of Prophets names as literal text without messages or private role details', () => {
    const context = dom();
    const capsule = {
      title: 'Opened capsule',
      status: 'opened',
      triggerType: 'manual',
      channel: { login: 'streamer' },
      sealedCount: 1,
      maxLength: 280,
      maxSealsPerUser: 3,
      prophets: [{ displayName: attack, predictions: 2 }],
    };
    runInNewContext(
      readFileSync(resolve(projectRoot, 'public/capsule/app.js'), 'utf8') +
        '\nrenderPublicCapsule(' +
        JSON.stringify(capsule) +
        ');',
      context,
    );
    expect(context.get('prophet-wall').hidden).toBe(false);
    expect(context.get('prophet-wall-list').children[0]?.textContent).toBe(
      '@' + attack + ' · PROPHET · 2 predictions came true',
    );
  });

  it('renders untrusted public titles and channel/category names as plain text', () => {
    const context = dom();
    const capsule = {
      title: attack,
      slug: 'test-capsule',
      status: 'sealing',
      triggerType: 'category',
      triggerValue: { category_id: '1', category_name: attack },
      channel: { login: 'streamer', displayName: attack },
      sealedCount: 2,
      maxLength: 280,
      maxSealsPerUser: 3,
    };
    runInNewContext(
      readFileSync(resolve(projectRoot, 'public/capsule/app.js'), 'utf8') +
        '\nrenderPublicCapsule(' +
        JSON.stringify(capsule) +
        ');',
      context,
    );
    expect(context.get('capsule-title').textContent).toBe(attack);
    expect(context.get('capsule-condition').textContent).toContain(attack);
    expect(context.get('sealed-count').textContent).toBe('2');
    expect(context.get('chat-link').href).toBe(
      'https://www.twitch.tv/streamer',
    );
  });
  it('renders untrusted dashboard capsule titles without innerHTML', () => {
    const context = dom();
    const capsule = {
      id: 1,
      title: attack,
      slug: 'test-capsule',
      status: 'sealing',
      triggerType: 'manual',
      channel: { login: 'streamer' },
      createdAt: new Date().toISOString(),
      sealedCount: 0,
      visibleCount: 0,
    };
    runInNewContext(
      readFileSync(
        resolve(projectRoot, 'public/dashboard/capsules.js'),
        'utf8',
      ) +
        '\nrenderCapsules(' +
        JSON.stringify([capsule]) +
        ');',
      context,
    );
    expect(
      context.get('capsule-list').children[0]?.children[0]?.children[0]
        ?.textContent,
    ).toBe(attack);
  });
});

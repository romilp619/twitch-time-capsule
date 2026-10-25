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

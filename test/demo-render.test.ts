import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../src/config.js';
class Element {
  textContent = '';
  src = '';
  href = '';
  className = '';
  hidden = false;
  disabled = false;
  value: string | number = '';
  clientWidth = 800;
  style = { transform: '' };
  dataset: Record<string, string> = {};
  children: Element[] = [];
  set innerHTML(_value: string) {
    throw new Error('Unsafe HTML rendering');
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
}
function fixture() {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = new Element();
      elements.set(id, element);
    }
    return element;
  };
  const render = runInNewContext(
    readFileSync(resolve(projectRoot, 'public/demo/app.js'), 'utf8') +
      '\nrenderDemo;',
    {
      document: {
        getElementById: get,
        createElement: () => new Element(),
        querySelector: () => new Element(),
        querySelectorAll: () => [],
      },
      location: {
        href: 'http://localhost:3001/demo',
        origin: 'http://localhost:3001',
      },
      URL,
      fetch: () => new Promise(() => {}),
      setInterval: () => 0,
      ResizeObserver: class {
        observe() {}
      },
    },
  ) as (data: unknown) => void;
  return { render, get };
}
const data = {
  state: 'idle',
  headline: 'Waiting',
  elapsedMs: 0,
  scenario: 'category',
  facts: { live: false, category: 'Just Chatting' },
  capsule: { status: 'sealing', sealedCount: 0 },
  ceremony: 'idle',
  vipCount: 0,
  messages: [],
  links: {
    overlay: 'http://localhost:3001/overlay?key=sample',
    dashboard: 'http://localhost:3001/dashboard?key=sample',
    public: 'http://localhost:3001/c/demo',
  },
};
describe('Demo page rendering', () => {
  it('renders simulated chat, headlines, and categories as literal text', () => {
    const { render, get } = fixture();
    const hostile = '<img src=x onerror=alert(1)>';
    render({
      ...data,
      headline: hostile,
      facts: { ...data.facts, category: hostile },
      messages: [{ text: hostile }],
    });
    expect(get('story-headline').textContent).toBe(hostile);
    expect(get('game-category').textContent).toBe(hostile);
    expect(get('demo-chat').children[0]?.children[1]?.textContent).toBe(
      hostile,
    );
  });
  it('refuses off-origin iframe and public links', () => {
    const { render } = fixture();
    expect(() =>
      render({
        ...data,
        links: { ...data.links, overlay: 'https://evil.invalid' },
      }),
    ).toThrow('local server');
  });
  it('disables story reentry, labels simulated facts, and keeps iframe URLs stable', () => {
    const { render, get } = fixture();
    render({ ...data, state: 'running', elapsedMs: 72000, vipCount: 1 });
    expect(get('play-story').disabled).toBe(true);
    expect(get('stop-story').disabled).toBe(false);
    expect(get('story-time').textContent).toBe('1:12 / 1:30');
    expect(get('vip-count').textContent).toBe('1');
    expect(get('demo-overlay').src).toBe(data.links.overlay);
    render({ ...data, state: 'completed', elapsedMs: 90000 });
    expect(get('stop-story').disabled).toBe(true);
    expect(get('demo-hint').textContent).toContain('Story complete');
  });
});

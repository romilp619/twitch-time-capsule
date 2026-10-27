import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectRoot } from '../src/config.js';
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  textContent = '';
  className = '';
  constructor(readonly tagName = 'div') {}
  set innerHTML(_value: string) {
    throw new Error('Unsafe HTML rendering');
  }
  setAttribute() {}
  classList = {
    add: (value: string) => {
      this.className += ' ' + value;
    },
  };
  append(...children: Node[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Node[]) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  querySelector(selector: string): Node | null {
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(' ').includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}
function fixture() {
  const stage = new Node('main');
  const timers = new Map<number, () => void>();
  let id = 0;
  const context = {
    document: {
      getElementById: () => stage,
      createElement: (tag: string) => new Node(tag),
    },
    location: {
      search: '?key=test-overlay',
      href: 'http://localhost:3000/overlay?key=test-overlay',
      protocol: 'http:',
    },
    URL,
    URLSearchParams,
    setTimeout: (fn: () => void) => {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout: (timer: number) => timers.delete(timer),
    setInterval: () => 0,
    addEventListener: () => {},
    fetch: () => new Promise(() => {}),
    WebSocket: class {
      readyState = 0;
      close() {}
    },
  };
  const render = runInNewContext(
    readFileSync(resolve(projectRoot, 'public/overlay/app.js'), 'utf8') +
      '\nrenderOverlay;',
    context,
  ) as (packet: unknown) => void;
  const flush = () => {
    for (const [key, fn] of [...timers]) {
      timers.delete(key);
      fn();
    }
  };
  return { stage, render, flush };
}
function card(id: number, text = 'Future message ' + id) {
  return {
    id,
    number: id,
    displayName: 'Viewer ' + id,
    text,
    createdAt: '2026-10-25T10:00:00Z',
    revealedAt: '2026-10-27T10:00:00Z',
  };
}
function packet(stage: string, cards: ReturnType<typeof card>[] = []) {
  return {
    type: 'ceremony',
    stage,
    preview: false,
    capsuleId: 1,
    startedAt: 1000,
    title: 'Future predictions',
    createdAt: '2026-10-25T10:00:00Z',
    sealedCount: 4,
    settings: { side: 'right', cardScale: 1, autoRevealSeconds: 8 },
    cards,
  };
}
function text(node: Node): string {
  return node.textContent + ' ' + node.children.map(text).join(' ');
}
describe('OBS overlay rendering and privacy', () => {
  it('renders hostile viewer text literally and never uses innerHTML', () => {
    const { render, stage } = fixture();
    const attack = '<img src=x onerror=alert(1)>';
    render(packet('reveal', [{ ...card(1, attack), displayName: attack }]));
    expect(text(stage)).toContain(attack);
    expect(
      stage
        .querySelector('.cards')
        ?.children[0]?.children.map((c) => c.tagName),
    ).toEqual(['p', 'p', 'blockquote']);
    expect(
      stage.querySelector('.cards')?.children[0]?.children[2]?.textContent,
    ).toBe(attack);
  });
  it('renders no elements when idle and clears all content after ending', () => {
    const { render, stage, flush } = fixture();
    render(packet('idle'));
    expect(stage.children).toEqual([]);
    render(packet('opening'));
    expect(text(stage)).toContain('TIME CAPSULE OPENED');
    render(packet('reveal', [card(1)]));
    expect(text(stage)).toContain('Future message 1');
    render(packet('idle'));
    flush();
    expect(stage.children).toEqual([]);
  });
  it('keeps three newest cards, reuses existing cards, and removes the old one', () => {
    const { render, stage, flush } = fixture();
    render(packet('reveal', [card(1), card(2), card(3)]));
    const second = stage.querySelector('.cards')!.children[1];
    render(packet('reveal', [card(2), card(3), card(4)]));
    flush();
    const cards = stage.querySelector('.cards')!.children;
    expect(cards).toHaveLength(3);
    expect(cards[0]).toBe(second);
    expect(text(stage)).not.toContain('Future message 1');
    expect(text(stage)).toContain('Future message 4');
  });
  it('shows only a small header during the queue and supports left/scaled cards', () => {
    const { render, stage } = fixture();
    render({
      ...packet('queue'),
      settings: { side: 'left', cardScale: 0.85, autoRevealSeconds: 8 },
    });
    expect(stage.className).toContain('side-left scale-small');
    expect(text(stage)).toContain('TIME CAPSULE · OPENED');
    expect(stage.querySelector('.cards')?.children).toEqual([]);
    const css = readFileSync(
      resolve(projectRoot, 'public/overlay/style.css'),
      'utf8',
    );
    expect(css).toContain('background: transparent !important');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});

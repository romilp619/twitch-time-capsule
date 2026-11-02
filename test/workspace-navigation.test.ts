import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { projectRoot } from '../src/config.js';

const names = ['capsules', 'ceremony', 'prophets', 'overlay', 'connection'];
function workspace(initialHash = '') {
  const callbacks = new Map<string, () => void>();
  let click: (event: unknown) => void = () => {};
  const location = { hash: initialHash };
  const scrollTo = vi.fn();
  const views = names.map((name) => ({
    hidden: false,
    dataset: { workspaceView: name },
    getAttribute: () => name + '-title',
  }));
  const links = names.map((name) => ({
    dataset: { workspaceNav: name },
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: () => '#' + name + '-title',
  }));
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const elements = new Map(
    names.map((name, index) => [
      name + '-title',
      {
        id: name + '-title',
        tagName: 'H2',
        parentElement: null,
        closest: () => views[index],
        focus: vi.fn(),
        scrollIntoView: vi.fn(),
      },
    ]),
  );
  const control = {
    id: 'auto-seconds',
    tagName: 'INPUT',
    parentElement: details,
    closest: () => views[3],
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
  };
  const history = {
    scrollRestoration: 'auto',
    pushState: vi.fn((_state, _title, hash: string) => {
      location.hash = hash;
    }),
  };
  runInNewContext(
    readFileSync(resolve(projectRoot, 'public/dashboard/workspace.js'), 'utf8'),
    {
      document: {
        querySelectorAll: (selector: string) =>
          selector.includes('workspace-view') ? views : links,
        getElementById: (id: string) =>
          id === 'auto-seconds' ? control : elements.get(id),
        addEventListener: (_name: string, callback: typeof click) => {
          click = callback;
        },
      },
      location,
      history,
      scrollTo,
      addEventListener: (name: string, callback: () => void) => {
        callbacks.set(name, callback);
      },
    },
  );
  function navigate(hash: string) {
    const preventDefault = vi.fn();
    click({
      target: { closest: () => ({ getAttribute: () => hash }) },
      preventDefault,
    });
    return preventDefault;
  }
  return {
    callbacks,
    control,
    details,
    elements,
    history,
    location,
    navigate,
    scrollTo,
    views,
  };
}

describe('Workspace navigation scroll position', () => {
  it.each(names)(
    'opens %s with the shared header at the top, including repeated clicks',
    (name) => {
      const ui = workspace('#connection-title');
      for (let repeat = 0; repeat < 2; repeat++) {
        ui.scrollTo.mockClear();
        expect(ui.navigate('#' + name + '-title')).toHaveBeenCalledOnce();
        expect(ui.location.hash).toBe('#' + name + '-title');
        expect(
          ui.views
            .filter((view) => !view.hidden)
            .map((view) => view.dataset.workspaceView),
        ).toEqual([name]);
        expect(ui.scrollTo).toHaveBeenLastCalledWith({
          top: 0,
          left: 0,
          behavior: 'instant',
        });
        expect(
          ui.elements.get(name + '-title')!.scrollIntoView,
        ).not.toHaveBeenCalled();
      }
    },
  );
  it('keeps links to specific controls working and opens their containing details', () => {
    const ui = workspace();
    ui.scrollTo.mockClear();
    expect(ui.navigate('#auto-seconds')).toHaveBeenCalledOnce();
    expect(ui.control.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(ui.control.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(ui.details.open).toBe(true);
    expect(ui.views[3]!.hidden).toBe(false);
    expect(ui.scrollTo).not.toHaveBeenCalled();
  });
  it('resets section fragments on reload and browser history navigation', () => {
    const ui = workspace('#prophets-title');
    expect(ui.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    });
    expect(ui.history.scrollRestoration).toBe('manual');
    ui.scrollTo.mockClear();
    ui.callbacks.get('load')!();
    expect(ui.scrollTo).toHaveBeenCalledOnce();
    ui.location.hash = '#ceremony-title';
    ui.callbacks.get('hashchange')!();
    expect(ui.views[1]!.hidden).toBe(false);
    expect(ui.scrollTo).toHaveBeenCalledTimes(2);
  });
});

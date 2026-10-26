export const nav = (globalThis.__nav ??= { pops: 0, pushes: [], stack: [], depth: 1 });
const api = {
  pop() { nav.pops += 1; },
  push(name, params) { nav.pushes.push({ name, params }); },
  replace() {},
  get stack() { return nav.stack; },
  get route() { return nav.stack[nav.stack.length - 1] ?? { name: 'Note', params: {} }; },
  depth: 1, poppingIndex: null, finishPop() {},
};
export function useNav() { return api; }

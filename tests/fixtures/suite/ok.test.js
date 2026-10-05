export const tests = {
  "ok one": () => {},
  "ok two": async () => { await new Promise((r) => setTimeout(r, 10)); },
};

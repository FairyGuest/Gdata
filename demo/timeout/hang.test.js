export const tests = {
  "quick case still runs": () => {
    // proves a hung sibling does not block independent cases
  },
  "hanging case": () => {
    // Synchronous infinite loop: only terminating the worker stops it.
    while (true) {}
  },
};

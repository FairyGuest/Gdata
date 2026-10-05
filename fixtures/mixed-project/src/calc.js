export function add(a, b) {
  return a + b;
}

export function isSame(a, b) {
  return a === b;
}

export function track(value) {
  console.log('tracking', value);
  return value;
}

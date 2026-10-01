export type IdGenerator = () => string;

export function createIdFactory(prefix: string, start = 1): IdGenerator {
  let counter = start;
  return () => `${prefix}_${String(counter++).padStart(6, "0")}`;
}

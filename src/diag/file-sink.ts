import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DiagSink } from './logger.js';

export function createFileSink(path: string): DiagSink {
  mkdirSync(dirname(path), { recursive: true });
  return (event) => {
    appendFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  };
}

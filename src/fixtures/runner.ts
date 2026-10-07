/**
 * Synthetic build executor (fixture). No real toolchain is invoked:
 * - waits buildDelayMs to simulate work (lets tests interleave events),
 * - fails when any watched file contains the marker TRIGGER_BUILD_FAILURE,
 * - otherwise succeeds and counts the build for assertions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetDefinition } from '../domain/types.ts';

export const FAILURE_MARKER = 'TRIGGER_BUILD_FAILURE';

export class BuildFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildFailure';
  }
}

export class FixtureRunner {
  /** target name -> number of actual build executions (observability for tests) */
  readonly buildCounts = new Map<string, number>();

  private readonly workspaceRoot: string;
  private readonly buildDelayMs: number;

  constructor(workspaceRoot: string, buildDelayMs: number) {
    this.workspaceRoot = workspaceRoot;
    this.buildDelayMs = buildDelayMs;
  }

  async execute(def: TargetDefinition): Promise<void> {
    if (this.buildDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.buildDelayMs));
    }
    for (const p of def.paths) {
      const abs = join(this.workspaceRoot, p);
      if (existsSync(abs) && readFileSync(abs, 'utf8').includes(FAILURE_MARKER)) {
        throw new BuildFailure(`fixture failure: ${p} contains ${FAILURE_MARKER}`);
      }
    }
    this.buildCounts.set(def.name, (this.buildCounts.get(def.name) ?? 0) + 1);
  }

  count(name: string): number {
    return this.buildCounts.get(name) ?? 0;
  }
}
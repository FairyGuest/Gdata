import { ContractError } from '../errors.js';
import type { TestCase, TestStatus } from '../contract/types.js';

export interface CaseQuery {
  status?: TestStatus;
  file?: string;
  name?: string;
  sort: 'file' | 'name' | 'status' | 'durationMs';
  order: 'asc' | 'desc';
}

const SORT_FIELDS = ['file', 'name', 'status', 'durationMs'] as const;
const STATUSES: TestStatus[] = ['passed', 'failed', 'skipped'];

/** Parses and validates the filter/sort query string for case listings. */
export function parseCaseQuery(raw: Record<string, string | undefined>): CaseQuery {
  const query: CaseQuery = { sort: 'file', order: 'asc' };
  if (raw.status !== undefined) {
    if (!STATUSES.includes(raw.status as TestStatus)) {
      throw new ContractError('INVALID_QUERY', 'invalid status filter: ' + raw.status, { field: 'status' });
    }
    query.status = raw.status as TestStatus;
  }
  if (raw.file !== undefined) query.file = raw.file;
  if (raw.name !== undefined) query.name = raw.name;
  if (raw.sort !== undefined) {
    if (!(SORT_FIELDS as readonly string[]).includes(raw.sort)) {
      throw new ContractError('INVALID_QUERY', 'invalid sort field: ' + raw.sort, { field: 'sort' });
    }
    query.sort = raw.sort as CaseQuery['sort'];
  }
  if (raw.order !== undefined) {
    if (raw.order !== 'asc' && raw.order !== 'desc') {
      throw new ContractError('INVALID_QUERY', 'invalid order: ' + raw.order, { field: 'order' });
    }
    query.order = raw.order;
  }
  return query;
}

/** Applies substring filters (file, name), exact status filter, then sorts. */
export function filterSortCases(cases: TestCase[], query: CaseQuery): TestCase[] {
  let result = cases;
  if (query.status !== undefined) {
    const status = query.status;
    result = result.filter((testCase) => testCase.status === status);
  }
  if (query.file !== undefined) {
    const needle = query.file.toLowerCase();
    result = result.filter((testCase) => testCase.file.toLowerCase().includes(needle));
  }
  if (query.name !== undefined) {
    const needle = query.name.toLowerCase();
    result = result.filter((testCase) => testCase.name.toLowerCase().includes(needle));
  }
  const direction = query.order === 'asc' ? 1 : -1;
  const field = query.sort;
  return [...result].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}


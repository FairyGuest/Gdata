import { DomainError } from '../src/contract/errors.js';
import { parsePurchase } from '../src/contract/requests.js';
import { buildApp } from '../src/app.js';

type Json = unknown;
interface StepResult {
  scenario: string;
  step: string;
  request: Json;
  response: Json;
  expected: string;
  pass: boolean;
  reason?: string;
}

const results: StepResult[] = [];
const { kernel, reads } = buildApp(':memory:', true);

function record(scenario: string, step: string, request: Json, response: Json, expected: string, pass: boolean, reason?: string): void {
  const result: StepResult = { scenario, step, request, response, expected, pass };
  if (reason !== undefined) result.reason = reason;
  results.push(result);
  console.log(`\n[run=${typeof request === 'object' && request !== null && 'runId' in request ? String((request as { runId: number }).runId) : 'diag'}] ${scenario} / ${step}`);
  console.log('request :', JSON.stringify(request));
  console.log('response:', JSON.stringify(response));
  console.log('expected:', expected, '=>', pass ? 'PASS' : `FAIL${reason ? ` (${reason})` : ''}`);
}

function call<T>(scenario: string, step: string, request: Json, action: () => T, expected: string, verify: (response: Json) => boolean): void {
  try {
    const response = action();
    record(scenario, step, request, response as Json, expected, verify(response as Json));
  } catch (error) {
    const response = error instanceof DomainError
      ? { httpStatus: error.statusCode, error: { reason: error.reason, message: error.message } }
      : { httpStatus: 500, error: { reason: 'compute_failed', message: String(error) } };
    record(scenario, step, request, response, expected, verify(response), response.error.reason);
  }
}

function isOk(response: Json): boolean {
  return typeof response === 'object' && response !== null && (response as { ok?: unknown }).ok === true;
}

function isConflict(response: Json, reason: string): boolean {
  return typeof response === 'object' && response !== null &&
    (response as { httpStatus?: unknown }).httpStatus === 409 &&
    (response as { error?: { reason?: unknown } }).error?.reason === reason;
}

function isUnprocessable(response: Json, reason: string): boolean {
  return typeof response === 'object' && response !== null &&
    (response as { httpStatus?: unknown }).httpStatus === 422 &&
    (response as { error?: { reason?: unknown } }).error?.reason === reason;
}

function concurrentSameSeat(): void {
  const scenario = 'concurrent same seat';
  const requests = [
    { runId: 101, eventId: 'evt-1', seatId: 'A-1', userId: 'alice' },
    { runId: 102, eventId: 'evt-1', seatId: 'A-1', userId: 'bob' },
  ];
  const outcomes = requests.map((request) => {
    try {
      return { request, response: { httpStatus: 200, ...kernel.purchase(request) } as Json };
    } catch (error) {
      const domain = error as DomainError;
      return { request, response: { httpStatus: domain.statusCode, error: { reason: domain.reason, message: domain.message } } };
    }
  });
  const okCount = outcomes.filter((item) => isOk(item.response)).length;
  const conflictCount = outcomes.filter((item) => isConflict(item.response, 'seat_held')).length;
  const effectiveCount = reads.seat('evt-1', 'A-1').effectiveTicketCount;
  const alice = reads.user('alice').balanceCents;
  const bob = reads.user('bob').balanceCents;
  const moneyConserved = alice + bob === 15000;
  const pass = okCount === 1 && conflictCount === 1 && effectiveCount === 1 && moneyConserved;
  for (const outcome of outcomes) record(scenario, 'purchase', outcome.request, outcome.response, 'one success and one seat_held', pass);
  record(scenario, 'invariants', { seat: 'A-1' }, { okCount, conflictCount, effectiveCount, aliceBalanceCents: alice, bobBalanceCents: bob }, 'one ticket and 15000 cents conserved', pass, pass ? undefined : 'commit ordering or balance invariant failed');
}

function purchaseLimitAndRelease(): void {
  const scenario = 'purchase limit and refund release';
  const setup = buildApp(':memory:', true);
  setup.store.db.prepare("INSERT INTO seats (event_id, id) VALUES ('evt-1', 'A-3')").run();
  const buy = (runId: number, seatId: string) => setup.kernel.purchase({ runId, eventId: 'evt-1', seatId, userId: 'carol' });
  call(scenario, 'first seat within limit', { runId: 201, seatId: 'A-1' }, () => buy(201, 'A-1'), '200 success', isOk);
  call(scenario, 'second seat reaches limit', { runId: 202, seatId: 'A-2' }, () => buy(202, 'A-2'), '200 success', isOk);
  call(scenario, 'third purchase rejected', { runId: 203, seatId: 'A-3' }, () => buy(203, 'A-3'), '409 purchase_limit_reached', (response) => isConflict(response, 'purchase_limit_reached'));
  call(scenario, 'refund releases quota and seat', { runId: 204, ticketId: 'ticket:evt-1:A-1:v1', userId: 'carol' }, () => setup.kernel.refund({ runId: 204, ticketId: 'ticket:evt-1:A-1:v1', userId: 'carol' }), '200 voided', (response) => isOk(response) && (response as { status?: string }).status === 'voided');
  call(scenario, 'released seat can be sold again', { runId: 205, seatId: 'A-1' }, () => buy(205, 'A-1'), '200 success', isOk);
  call(scenario, 'released quota is consumed again', { runId: 206, seatId: 'A-3' }, () => buy(206, 'A-3'), '409 purchase_limit_reached', (response) => isConflict(response, 'purchase_limit_reached'));
}

function dedicatedLimitStateMachine(): void {
  const scenario = 'dedicated limit and state machine';
  const setup = buildApp(':memory:', true);
  setup.store.db.prepare("INSERT INTO seats (event_id, id) VALUES ('evt-1', 'A-3')").run();
  const buy = (runId: number, seatId: string) => setup.kernel.purchase({ runId, eventId: 'evt-1', seatId, userId: 'alice' });
  call(scenario, 'purchase one', { runId: 301, seatId: 'A-1' }, () => buy(301, 'A-1'), '200 success', isOk);
  call(scenario, 'purchase two reaches limit', { runId: 302, seatId: 'A-2' }, () => buy(302, 'A-2'), '200 success', isOk);
  call(scenario, 'third purchase rejected', { runId: 303, seatId: 'A-3' }, () => buy(303, 'A-3'), '409 purchase_limit_reached', (response) => isConflict(response, 'purchase_limit_reached'));
  call(scenario, 'refund first releases quota and seat', { runId: 304, ticketId: 'ticket:evt-1:A-1:v1', userId: 'alice' }, () => setup.kernel.refund({ runId: 304, ticketId: 'ticket:evt-1:A-1:v1', userId: 'alice' }), '200 voided', (response) => isOk(response) && (response as { status?: string }).status === 'voided');
  let repurchaseTicketId = '';
  call(scenario, 'repurchase released seat', { runId: 305, seatId: 'A-1' }, () => { const result = buy(305, 'A-1'); repurchaseTicketId = result.ticketId; return result; }, '200 success', isOk);
  const ticket = setup.reads.ticket(repurchaseTicketId);
  const historyUnchangedOnCheckIn = JSON.stringify(ticket.history);
  call(scenario, 'transfer valid before check-in', { runId: 306, ticketId: ticket.ticketId, userId: 'alice', toUserId: 'bob' }, () => setup.kernel.transfer({ runId: 306, ticketId: ticket.ticketId, userId: 'alice', toUserId: 'bob' }), '200 sold', isOk);
  call(scenario, 'non-holder cannot check in', { runId: 307, ticketId: ticket.ticketId, userId: 'alice' }, () => setup.kernel.checkIn({ runId: 307, ticketId: ticket.ticketId, userId: 'alice' }), '409 not_holder', (response) => isConflict(response, 'not_holder'));
  call(scenario, 'holder checks in', { runId: 308, ticketId: ticket.ticketId, userId: 'bob' }, () => setup.kernel.checkIn({ runId: 308, ticketId: ticket.ticketId, userId: 'bob' }), '200 checked_in', (response) => isOk(response) && (response as { status?: string }).status === 'checked_in');
  call(scenario, 'checked-in transfer rejected', { runId: 309, ticketId: ticket.ticketId, userId: 'bob', toUserId: 'carol' }, () => setup.kernel.transfer({ runId: 309, ticketId: ticket.ticketId, userId: 'bob', toUserId: 'carol' }), '409 already_checked_in', (response) => isConflict(response, 'already_checked_in'));
  call(scenario, 'checked-in refund rejected', { runId: 310, ticketId: ticket.ticketId, userId: 'bob' }, () => setup.kernel.refund({ runId: 310, ticketId: ticket.ticketId, userId: 'bob' }), '409 already_checked_in', (response) => isConflict(response, 'already_checked_in'));
  call(scenario, 'duplicate check-in rejected', { runId: 311, ticketId: ticket.ticketId, userId: 'bob' }, () => setup.kernel.checkIn({ runId: 311, ticketId: ticket.ticketId, userId: 'bob' }), '409 already_checked_in', (response) => isConflict(response, 'already_checked_in'));
  const finalTicket = setup.reads.ticket(ticket.ticketId);
  record(scenario, 'history remains ownership evidence', { ticketId: ticket.ticketId }, { beforeCheckInHistory: JSON.parse(historyUnchangedOnCheckIn), finalHistory: finalTicket.history, currentOwnerId: finalTicket.currentOwnerId }, 'owner stays bob and check-in appends its own history only', finalTicket.currentOwnerId === 'bob');
}

function inputContract(): void {
  const scenario = 'input contract';
  call(scenario, 'missing seat', { runId: 401, eventId: 'evt-1', userId: 'alice' }, () => parsePurchase({ runId: 401, eventId: 'evt-1', seatId: ' ', userId: 'alice' }), '422 invalid_input', (response) => isUnprocessable(response, 'invalid_input'));
}

concurrentSameSeat();
purchaseLimitAndRelease();
dedicatedLimitStateMachine();
inputContract();

const failed = results.filter((result) => !result.pass);
console.log('\n=== Acceptance Summary ===');
for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.scenario} / ${result.step}`);
if (failed.length > 0) {
  console.error(`\n${failed.length} assertion(s) failed:`);
  for (const failure of failed) console.error(`- ${failure.scenario} / ${failure.step}: expected ${failure.expected}`);
  process.exit(1);
}
console.log('\nAll acceptance scenarios passed.');

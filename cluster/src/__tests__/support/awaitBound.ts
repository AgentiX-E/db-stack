/**
 * A bound on every wait the suite performs on a promise the product owns.
 *
 * A test that awaits `transport.start()` is waiting on a *resolution*, and the
 * only line that resolves it is one a mutation can delete — `resolve()` becomes
 * `;`, a force-close timer's callback becomes `() => undefined`, a flush is never
 * scheduled. The case then never returns. Vitest reports `Test timed out in
 * 15000ms` for it, the worker is killed mid-file, the remaining cases in that file
 * never run, and the mutation report records a timeout: a verdict that says *the
 * runner gave up*, not *the suite objected* (P3-75).
 *
 * Bounding the wait at the call site turns the same edit into an assertion failure
 * with a name, in the file and the case that noticed — and a case that fails is a
 * mutant that is killed, which is the difference between the gate measuring the
 * suite and the gate measuring its patience.
 *
 * The budget is a property of the machine, not of the operation. A real transport
 * binds a loopback port in 35 ms and tears it down in 0.5 ms (measured on the tree
 * this was written against), so 1.2 s is that by thirty times over. It is also the
 * number that makes a *verdict* possible: a mutant that leaves fifteen stops
 * unresolved must still finish inside the mutation suite's thirty-second
 * abandonment, and 15 × 1.2 s is 18 s while 15 × 3 s is 45 s — a suite that spends
 * longer than the cap is a suite the gate abandons, which is the same silence in a
 * different place.
 */
export const TRANSPORT_BUDGET_MS = 1_200;

/**
 * Await `work`, but stop waiting after `budgetMs` and fail with `what` named.
 *
 * `Promise.race` leaves `work` running; that is deliberate. The point is to stop
 * *waiting*, not to cancel a product operation mid-flight — a test that cancelled
 * would be asserting on a state the product never reaches.
 */
export async function bounded<T>(work: Promise<T>, what: string, budgetMs: number = TRANSPORT_BUDGET_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${budgetMs} ms`)), budgetMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

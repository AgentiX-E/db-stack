/**
 * Cron grammar — the five fields a maintenance window may be described with.
 *
 * The grammar is small, it is the part of a schedule an operator types by hand,
 * and it decides *when work runs*. It therefore lives in its own module with
 * its own tests rather than inside the scheduler: a field such as `0-70/5` has
 * an outcome a caller can assert on directly (which minutes matched), while the
 * same mistake observed through occurrence projection is indistinguishable from
 * "this window never fires".
 *
 * Nothing here throws on malformed input. A cron expression that names nothing
 * yields empty sets, which projects to no occurrences — the schedule is inert,
 * and the caller can see that. Only a field count below five is an error,
 * because `"0 3 * *"` is not a schedule at all.
 *
 * @module @agentix-e/db-maintenance/impl
 */

/** The five fields, each resolved to the values it names. */
export interface CronSchedule {
  /** Minutes past the hour, `0..59`. */
  minutes: Set<number>;
  /** Hours of the day, `0..23`. */
  hours: Set<number>;
  /** Days of the month, `1..31`. */
  daysOfMonth: Set<number>;
  /** Months of the year, `1..12`. */
  months: Set<number>;
  /** Days of the week, `0..6`, Sunday is `0`. */
  daysOfWeek: Set<number>;
}

/**
 * Resolve one cron field to the values it names, bounded by `min..max`.
 *
 * Accepted forms, each taken from real expressions rather than invented:
 *
 *   - `*` — every value in range;
 *   - `a` — one value, dropped when it is outside `min..max` (`months: 0` names
 *     no month, so it matches no month instead of rolling into December);
 *   - `a-b` — an inclusive range, clamped to `min..max` at both ends, which is
 *     what makes `minutes: 0-70` name `0..59` rather than 71 minutes that do not
 *     exist;
 *   - `*\/n`, `a/n`, `a-b/n` — a range walked by `n`, clamped the same way. A
 *     step that is not a positive number names nothing: `*\/0` is not "every
 *     minute", it is a typo, and the span divided by it is infinite.
 *
 * Comma-separated lists combine any of the above.
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (const value of valuesBetween(min, max)) values.add(value);
      continue;
    }

    // Split and read the tail, rather than searching for the separator: the
    // presence of a step or a range is then a property of the split, which the
    // tests can distinguish, instead of a sentinel `indexOf` return value that
    // every malformed part shares with every other.
    // `split` always yields at least the whole string, so index 0 exists by
    // construction; the tail is what tells a stepped or ranged part apart.
    const slashParts = part.split('/');
    const head = slashParts[0]!;
    const stepParts = slashParts.slice(1);
    if (stepParts.length) {
      addStepped(values, head, stepParts.join('/'), min, max);
      continue;
    }

    const dashParts = head.split('-');
    const lowSpec = dashParts[0]!;
    const highParts = dashParts.slice(1);
    if (highParts.length) {
      addRange(values, lowSpec, highParts.join('-'), min, max);
      continue;
    }

    const value = Number.parseInt(head, 10);
    if (value >= min && value <= max) values.add(value);
  }

  return values;
}

/**
 * Every integer in `low..high`, inclusive — the list a field's values are drawn
 * from.
 *
 * A list rather than a counted loop, and the difference is the reason this
 * function exists. `for (let value = low; value <= high; value++)` is a promise
 * that the update expression goes the way its guard expects, and a mutation of
 * either one produces a loop no timer can interrupt: JavaScript cannot preëmpt
 * synchronous code, so the suite never gets to report the hang and the mutation
 * run records an abandoned run instead of a failing test. An array has no
 * counter to mutate — the worst an edit here can do is name the wrong values,
 * and a wrong value is an assertion with a name.
 *
 * `Array.from` clamps a negative or `NaN` length to zero, so an inverted range
 * is the empty list without a branch of its own.
 */
function valuesBetween(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
}

/**
 * The values a stepped range names: `low`, `low + step`, `low + 2 × step`, …
 * while they are at most `high`.
 *
 * The count is arithmetic, so the walk is an array: a step that is not positive
 * divides the span into infinitely many values, and `Array.from` refuses that by
 * throwing rather than by looping — the guard below is what keeps a typo from
 * reaching it.
 */
function steppedValues(low: number, high: number, step: number): number[] {
  const count = Math.floor((high - low) / step) + 1;
  return Array.from({ length: count }, (_, index) => low + index * step);
}

/**
 * Add `low-high` to `target`, clamped to the field's real range.
 *
 * A bound that is not a number leaves the list empty rather than throwing:
 * `"-5"` names no range, and a schedule that names nothing is inert.
 */
function addRange(target: Set<number>, lowSpec: string, highSpec: string, min: number, max: number): void {
  const low = Math.max(Number.parseInt(lowSpec, 10), min);
  const high = Math.min(Number.parseInt(highSpec, 10), max);
  for (const value of valuesBetween(low, high)) target.add(value);
}

/**
 * Add a stepped range to `target`.
 *
 * `rangeSpec` is `*`, a single number (`a/n`: from `a` to the field maximum), or
 * `a-b`. The clamp is applied per value instead of to the bounds, so `0-70/5`
 * names `0,5,...,55` and drops `60,65,70` instead of extending the hour.
 */
function addStepped(target: Set<number>, rangeSpec: string, stepSpec: string, min: number, max: number): void {
  const step = Number.parseInt(stepSpec, 10);
  // One comparison, written so that every mutation of it is observable: `>=`
  // lets a zero step through, and a zero step is a division by zero rather than
  // a schedule, which `steppedValues` answers with the empty list. `NaN` fails
  // this comparison too, so a step that is not a number names nothing either.
  if (!(step > 0)) return;

  let low = min;
  let high = max;
  if (rangeSpec !== '*') {
    const bounds = rangeSpec.split('-');
    low = Number.parseInt(bounds[0]!, 10);
    const highParts = bounds.slice(1);
    // A single number names "from here to the end of the field".
    if (highParts.length) high = Number.parseInt(highParts.join('-'), 10);
  }

  for (const value of steppedValues(low, high, step)) {
    if (value >= min && value <= max) target.add(value);
  }
}

/**
 * Parse a five-field cron expression: `minute hour day-of-month month day-of-week`.
 *
 * @throws If fewer than five fields are given. More than five are ignored: a
 * sixth field is a year in dialects that have one, and a scheduler that reads
 * only the five it implements is honest about which of them it honours.
 */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length < 5) {
    throw new Error(`Invalid cron expression: "${expression}" — expected 5 fields`);
  }
  return {
    minutes: parseCronField(fields[0]!, 0, 59),
    hours: parseCronField(fields[1]!, 0, 23),
    daysOfMonth: parseCronField(fields[2]!, 1, 31),
    months: parseCronField(fields[3]!, 1, 12),
    daysOfWeek: parseCronField(fields[4]!, 0, 6),
  };
}

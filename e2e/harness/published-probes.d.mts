/**
 * Types for `published-probes.mjs`.
 *
 * The probes are a child programme (plain `.mjs`, loaded by a `node` process the
 * test runner has not transformed), so they cannot be annotated inline. This
 * declaration gives the runner and the test file the shape without turning the file
 * they describe into TypeScript — the same arrangement `scripts/test-tmpdir.d.mts`
 * has with `scripts/test-tmpdir.mjs`.
 */

type AssertModule = typeof import('node:assert/strict');

export interface ProbeContext {
  loaded: Record<string, any>;
  assert: AssertModule;
}

export interface PublishedProbe {
  /** What the probe establishes, in one line — the name a failure is reported under. */
  name: string;
  /** The package name, spelled the way a consumer writes it in an import. */
  specifier: string;
  /** Symbols the published artefact must export. */
  expect: string[];
  /** The behaviour, called inside the child process. */
  behaviour: (context: ProbeContext) => void | Promise<void>;
}

export const PROBES: PublishedProbe[];

/**
 * The probes that must fail. They are programmes of the same shape, kept apart in
 * the runner's list so a control can never be counted as a claim.
 */
export const CONTROLS: PublishedProbe[];

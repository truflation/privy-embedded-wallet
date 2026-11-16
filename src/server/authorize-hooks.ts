import { redact, type Logger } from './logger';
import type { Session } from './types';

type Hook<T> = (
  session: Session,
  input: Readonly<T>,
) => boolean | Promise<boolean>;

/** Validates an optional host hook. `name` is the option name, for errors. */
export function readAuthorizeHook<H extends Hook<never>>(
  hook: H | undefined,
  name: string,
): H | null {
  if (hook === undefined) return null;
  if (typeof hook !== 'function') {
    throw new TypeError(`${name} must be a function.`);
  }
  return hook;
}

/**
 * Runs a host hook. Only a literal `true` allows the request. A hook that
 * throws or rejects is a denial, logged with its message redacted, so a
 * broken hook fails closed. The input itself is never logged.
 */
export async function passesHook<T extends object>(
  hook: Hook<T> | null,
  /** The option name and what it guards, for the log line. */
  label: { name: string; subject: string },
  session: Session,
  input: Readonly<T>,
  logger: Logger,
): Promise<boolean> {
  if (!hook) return true;
  try {
    return (await hook(session, input)) === true;
  } catch (error) {
    logger.error(`${label.name} threw; denying the ${label.subject}`, {
      error: error instanceof Error ? error.name : typeof error,
      detail: error instanceof Error ? redact(error.message) : undefined,
    });
    return false;
  }
}

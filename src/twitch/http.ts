import { z } from 'zod';
export type TwitchFetch = typeof fetch;
export class TwitchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TwitchError';
  }
}
export async function safeFetch(
  fetcher: TwitchFetch,
  url: string | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  } catch {
    throw new TwitchError(
      0,
      'Cannot reach Twitch. Check your connection and try again.',
    );
  }
}
export async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const result = schema.safeParse(await response.json());
    if (result.success) return result.data;
  } catch {
    /* Never forward provider bodies or schema errors: they may contain secrets. */
  }
  throw new TwitchError(
    502,
    'Twitch returned an unexpected response. Please try again.',
  );
}
export function safeMessage(error: unknown): string {
  return error instanceof TwitchError
    ? error.message
    : 'The operation failed. Check local storage permissions and try again.';
}

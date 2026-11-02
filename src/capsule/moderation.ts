import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CapsuleError } from './model.js';

export function parseSealCommand(message: string): string | null {
  const match = /^!seal(?:\s+([\s\S]*))?$/iu.exec(message.trim());
  return match ? (match[1] ?? '').trim() : null;
}
export function validateSealText(text: string, maxLength: number): void {
  const length = Array.from(text).length;
  if (length === 0)
    throw new CapsuleError(
      400,
      'Add your prediction after !seal. Example: !seal We will win the next round.',
    );
  if (length < 3)
    throw new CapsuleError(
      400,
      'Your prediction is too short. Write at least 3 characters after !seal.',
    );
  if (length > maxLength)
    throw new CapsuleError(
      400,
      'Your prediction is too long. Use at most ' +
        maxLength +
        ' characters after !seal.',
    );
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    throw new CapsuleError(
      400,
      'That message contains unsupported control characters.',
    );
}
export function containsBlockedWord(
  text: string,
  words: readonly string[],
): boolean {
  return words.some((word) => {
    const escaped = Array.from(word)
      .map((character) =>
        '\\^$.*+?()[]{}|'.includes(character) ? '\\' + character : character,
      )
      .join('');
    return new RegExp(
      '(^|[^\\p{L}\\p{N}_])' + escaped + '(?=$|[^\\p{L}\\p{N}_])',
      'iu',
    ).test(text.normalize('NFKC'));
  });
}
export class BlockedWords {
  readonly path: string;
  private stamp = '';
  private words: string[] = [];
  constructor(dataDir: string) {
    this.path = resolve(dataDir, 'blocked-words.txt');
    try {
      writeFileSync(
        this.path,
        '# One blocked word or phrase per line. Case-insensitive, whole words.\n# Lines beginning with # are comments. Changes apply without restart.\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw new CapsuleError(
          503,
          'Cannot create the blocked-word file. Check data directory permissions.',
        );
    }
  }
  contains(text: string): boolean {
    try {
      const stat = statSync(this.path);
      if (stat.size > 64 * 1024) throw new Error('Oversized file');
      const stamp = stat.mtimeMs + ':' + stat.size;
      if (stamp !== this.stamp) {
        this.words = readFileSync(this.path, 'utf8')
          .split(/\r?\n/u)
          .map((line) => line.trim().normalize('NFKC'))
          .filter((line) => line.length > 0 && !line.startsWith('#'));
        this.stamp = stamp;
      }
      return containsBlockedWord(text, this.words);
    } catch {
      throw new CapsuleError(
        503,
        'Cannot read blocked words. Check data/blocked-words.txt before accepting more seals.',
      );
    }
  }
}

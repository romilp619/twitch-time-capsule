import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapsuleCommands,
  type DeleteChatMessage,
} from '../src/capsule/commands.js';
import { CapsuleStore } from '../src/capsule/store.js';
import { BlockedWords } from '../src/capsule/moderation.js';
import {
  ReplyBatcher,
  type ReplySender,
  type SealAcknowledgement,
} from '../src/capsule/replies.js';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { TwitchError } from '../src/twitch/http.js';
import { chatEvent } from './eventsub-helper.js';
import { twitchProject } from './twitch-helper.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
const owner = { id: '1', login: 'streamer', displayName: 'Streamer' };
function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  let now = Date.now();
  const store = new CapsuleStore(
    db,
    () => {},
    () => now,
  );
  const capsule = store.create(
    { title: 'Future predictions', triggerType: 'manual' },
    owner,
  );
  const blocked = new BlockedWords(project.config.dataDir);
  const sender: ReplySender = {
    send: vi.fn<ReplySender['send']>(async () => 'reply-id'),
  };
  const remove = vi.fn<DeleteChatMessage>(async () => {});
  const log = new EventLog(db);
  const commands = new CapsuleCommands(
    store,
    blocked,
    sender,
    remove,
    log,
    'http://localhost:3000',
    () => now,
  );
  cleanup.push(() => commands.close());
  return {
    ...project,
    db,
    store,
    capsule,
    sender,
    remove,
    log,
    commands,
    blocked,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
describe('Sealing workflow', () => {
  it('stores then deletes only the specific accepted message and confirms its number', async () => {
    const { commands, remove, sender, db, capsule } = fixture();
    const event = chatEvent(
      '!seal this will come true',
      'viewer',
      'specific-chat-id',
    );
    await commands.handle(event, '1');
    expect(remove).toHaveBeenCalledWith('1', '1', 'specific-chat-id');
    expect(db.prepare('SELECT number, text, hidden FROM seals').get()).toEqual({
      number: 1,
      text: 'this will come true',
      hidden: 1,
    });
    await commands.batcher.flush();
    expect(sender.send).toHaveBeenCalledWith(
      expect.stringContaining('Sealed message #1 from @viewer.'),
      { broadcasterId: '1', senderId: '1' },
    );
    expect(db.prepare('SELECT capsule_id FROM seals').get()).toEqual({
      capsule_id: capsule.id,
    });
  });
  it('retains moderator seals as visible without trying an impossible deletion', async () => {
    const { commands, remove, sender, db } = fixture();
    const event = {
      ...chatEvent('!seal a moderator prediction', 'mod'),
      badges: [{ set_id: 'moderator' }],
    };
    await commands.handle(event, '1');
    await commands.batcher.flush();
    expect(remove).not.toHaveBeenCalled();
    expect(db.prepare('SELECT hidden FROM seals').get()).toEqual({ hidden: 0 });
    expect(sender.send).toHaveBeenCalledWith(
      expect.stringContaining(
        "mods' and the streamer's messages can't be hidden",
      ),
      expect.anything(),
    );
  });
  it('preserves a seal and warns honestly if deletion fails', async () => {
    const { commands, remove, sender, store, capsule, log } = fixture();
    remove.mockRejectedValue(new TwitchError(403, 'Bot is not a moderator.'));
    await commands.handle(chatEvent('!seal private prediction'), '1');
    await commands.batcher.flush();
    expect(store.get(capsule.id)?.sealedCount).toBe(1);
    expect(store.get(capsule.id)?.visibleCount).toBe(1);
    expect(commands.warnings[0]).toContain('could not be hidden');
    expect(JSON.stringify(log.latest())).not.toContain('private prediction');
    expect(sender.send).toHaveBeenCalledWith(
      expect.stringContaining("couldn't hide this message"),
      expect.anything(),
    );
  });
  it('rejects blocked or invalid text without storing it or deleting chat', async () => {
    const { commands, blocked, remove, db, log } = fixture();
    writeFileSync(blocked.path, 'forbidden\n');
    await commands.handle(
      chatEvent('!seal forbidden prediction', 'viewer-a'),
      '1',
    );
    await commands.handle(chatEvent('!seal ab', 'viewer-b'), '1');
    await commands.batcher.flush();
    expect(remove).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS count FROM seals').get()).toEqual({
      count: 0,
    });
    expect(JSON.stringify(log.latest())).not.toContain('forbidden prediction');
  });
  it('batches a burst into one accurate reply with a sequential number range', async () => {
    const { commands, sender, store, capsule } = fixture();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        commands.handle(
          chatEvent('!seal prediction ' + index, 'viewer-' + index),
          '1',
        ),
      ),
    );
    expect(sender.send).not.toHaveBeenCalled();
    await commands.batcher.flush();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(
      expect.stringContaining('Sealed #1-20 from @viewer-0'),
      expect.anything(),
    );
    expect(store.get(capsule.id)?.sealedCount).toBe(20);
  });
  it('gates moderator commands by badges and preserves existing seals after lock', async () => {
    const { commands, store, capsule } = fixture();
    await commands.handle(chatEvent('!seal remember this'), '1');
    await commands.handle(
      { ...chatEvent('!capsule lock', 'vip'), badges: [{ set_id: 'vip' }] },
      '1',
    );
    expect(store.get(capsule.id)?.status).toBe('sealing');
    await commands.handle(
      {
        ...chatEvent('!capsule lock', 'moderator'),
        badges: [{ set_id: 'moderator' }],
      },
      '1',
    );
    expect(store.get(capsule.id)?.status).toBe('locked');
    expect(commands.describe('1')).toContain('locked | 1 sealed');
    expect(commands.describe('1')).toContain('/c/' + capsule.slug);
  });
  it('deduplicates accepted seals using the database even after chat cache loss', async () => {
    const { commands, remove, store, capsule } = fixture();
    const event = chatEvent(
      '!seal a unique prediction',
      'viewer',
      randomUUID(),
    );
    await commands.handle(event, '1');
    await commands.handle(event, '1');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store.get(capsule.id)?.sealedCount).toBe(1);
  });
});
describe('Three-second reply window', () => {
  it('combines acknowledgements only after the batch window expires', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    cleanup.push(() => {
      db.close();
    });
    const sender: ReplySender = {
      send: vi.fn<ReplySender['send']>(async () => 'sent'),
    };
    const batch = new ReplyBatcher(sender, new EventLog(db), () => {});
    cleanup.push(() => batch.close());
    const entry: SealAcknowledgement = {
      capsuleId: 1,
      number: 1,
      userLogin: 'a',
      condition: 'when the streamer opens it',
      visibility: 'hidden',
      context: { broadcasterId: '1', senderId: '1' },
    };
    batch.acknowledge(entry);
    batch.acknowledge({ ...entry, number: 2, userLogin: 'b' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(sender.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(
      expect.stringContaining('#1-2'),
      entry.context,
    );
  });
});

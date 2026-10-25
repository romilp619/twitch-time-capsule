import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { TwitchAuth } from '../src/twitch/auth.js';
import { HelixClient } from '../src/twitch/helix.js';
import { ChatCommands, ChatSender, truncateChat } from '../src/twitch/chat.js';
import { openDatabase } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { FakeTwitch, twitchProject } from './twitch-helper.js';
import { chatEvent } from './eventsub-helper.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const project = twitchProject();
  cleanup.push(project.cleanup);
  const fake = new FakeTwitch();
  let now = Date.now();
  const auth = new TwitchAuth(project.config, fake.fetch);
  cleanup.push(() => auth.close());
  await auth.connect('streamer', 'streamer-code');
  const db = openDatabase(':memory:');
  cleanup.push(() => {
    db.close();
  });
  const log = new EventLog(db);
  const sender = new ChatSender(
    auth,
    new HelixClient(auth, fake.fetch),
    () => now,
  );
  const commands = new ChatCommands(sender, log, () => now);
  return {
    auth,
    fake,
    commands,
    log,
    sender,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
describe('Chat sending and Phase 3 command handling', () => {
  it('replies with the correct sender and channel for !capsule and logs the result', async () => {
    const { commands, fake, log } = await fixture();
    await commands.receive(chatEvent('!capsule'), '1');
    expect(fake.sentMessages).toEqual([
      {
        broadcaster_id: '1',
        sender_id: '1',
        message: 'No capsule is open for sealing right now.',
      },
    ]);
    expect(log.latest()[0]?.type).toBe('chat.sent');
  });
  it('enforces the channel cooldown, deduplicates chat IDs, and ignores own-account commands', async () => {
    const { commands, fake, advance } = await fixture();
    const event = chatEvent('!capsule', 'viewer', 'same-chat-id');
    await commands.receive(event, '1');
    await commands.receive(event, '1');
    await commands.receive(chatEvent('!capsule', 'other-viewer'), '1');
    await commands.receive(chatEvent('!capsule', '1'), '1');
    expect(fake.sentMessages).toHaveLength(1);
    advance(30_001);
    await commands.receive(chatEvent('!CAPSULE'), '1');
    expect(fake.sentMessages).toHaveLength(2);
  });
  it('logs normal chat as text but omits the contents of !seal commands', async () => {
    const { commands, log } = await fixture();
    await commands.receive(chatEvent('<img src=x onerror=alert(1)>'), '1');
    await commands.receive(chatEvent('!seal private prediction'), '1');
    const rows = JSON.stringify(log.latest());
    expect(rows).toContain('<img src=x onerror=alert(1)>');
    expect(rows).toContain('[seal text omitted]');
    expect(rows).not.toContain('private prediction');
  });
  it('cancels a queued reply if its account disconnects before sending', async () => {
    const { auth, sender, fake } = await fixture();
    const queued = sender.send('This should not be posted');
    auth.disconnect('streamer');
    await expect(queued).rejects.toThrow();
    expect(fake.sentMessages).toHaveLength(0);
  });
  it('truncates to 500 Unicode code points without splitting surrogate pairs', () => {
    const emoji = String.fromCodePoint(0x1f52e);
    const text = truncateChat(emoji.repeat(501));
    expect(Array.from(text)).toHaveLength(500);
    expect(text).toBe(emoji.repeat(500));
  });
  it('surfaces a Twitch dropped-message result instead of claiming the reply was sent', async () => {
    const { fake, sender, log } = await fixture();
    fake.dropMessages = true;
    await expect(sender.send('A test reply')).rejects.toThrow(
      'Twitch did not send',
    );
    expect(log.latest().some((row) => row.type === 'chat.sent')).toBe(false);
  });
  it('refuses a request if the token user differs from the expected sender', async () => {
    const { auth, fake } = await fixture();
    const helix = new HelixClient(auth, fake.fetch);
    const count = fake.fetch.mock.calls.length;
    await expect(
      helix.request('streamer', '/users', z.unknown(), {
        expectedUserId: 'different-user',
      }),
    ).rejects.toThrow('account changed');
    expect(fake.fetch.mock.calls).toHaveLength(count);
  });
});
describe('Private event log', () => {
  it('redacts credential fields and known credentials in strings', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => {
      db.close();
    });
    const log = new EventLog(
      db,
      () => {},
      () => ['private-value-123'],
    );
    log.write('test', {
      token: 'not-safe',
      message: 'contains private-value-123',
      nested: { client_secret: 'secret' },
    });
    const text = JSON.stringify(log.latest());
    expect(text).not.toContain('not-safe');
    expect(text).not.toContain('private-value-123');
    expect(text).not.toContain('"secret"');
  });
  it('returns the newest 100 and retains at most 1000 events', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => {
      db.close();
    });
    const log = new EventLog(db);
    for (let index = 0; index < 1100; index++) log.write('test', { index });
    expect(log.latest()).toHaveLength(100);
    expect(log.latest()[0]?.payload.index).toBe(1099);
    expect(
      db.prepare('SELECT count(*) AS count FROM events_log').get(),
    ).toEqual({ count: 1000 });
  });
});

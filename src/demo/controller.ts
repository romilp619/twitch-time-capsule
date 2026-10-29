import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectRoot, type AppConfig } from '../config.js';
import type {
  AdminCheck,
  ServerExtension,
  ServerServices,
} from '../server-extension.js';
import { CapsuleCommands } from '../capsule/commands.js';
import { CapsuleError } from '../capsule/model.js';
import { ChatCommands } from '../twitch/chat.js';
import {
  FakeTwitch,
  demoChannel,
  demoCategory,
  demoCategoryId,
} from './fake-twitch.js';
import { sampleViewers } from './samples.js';
import { storySteps, storyDurationMs } from './story.js';
export class DemoClock {
  private offset = 0;
  readonly now = () => Date.now() + this.offset;
  advance(ms: number): void {
    this.offset += Math.max(0, ms);
  }
}
export class DemoController implements ServerExtension {
  readonly mode = 'demo' as const;
  private services!: ServerServices;
  private commands!: ChatCommands;
  private seals!: CapsuleCommands;
  private capsuleId: number | null = null;
  private scenario: 'category' | 'date' | 'followers' = 'category';
  private seeded = new Set<number>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | null = null;
  private elapsed = 0;
  private nextStep = 0;
  private state: 'idle' | 'running' | 'stopped' | 'completed' | 'error' =
    'idle';
  private headline = 'The future starts with one message.';
  private error: string | null = null;
  constructor(
    readonly config: AppConfig,
    readonly twitch: FakeTwitch,
    readonly clock: DemoClock,
    private readonly realNow: () => number = Date.now,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new CapsuleError(503, 'Demo is stopping.'));
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  register(
    app: FastifyInstance,
    services: ServerServices,
    requireAdmin: AdminCheck,
  ): void {
    this.services = services;
    this.seals = new CapsuleCommands(
      services.capsules,
      services.blockedWords,
      services.sender,
      (channel, sender, id) =>
        services.helix.deleteChatMessage(channel, sender, id),
      services.log,
      this.config.baseUrl,
      this.clock.now,
      3000,
      (id) => services.triggers.action(id, 'open'),
    );
    this.commands = new ChatCommands(
      services.sender,
      services.log,
      this.clock.now,
      this.seals,
    );
    for (const [url, file, type] of [
      ['/demo', 'index.html', 'text/html'],
      ['/demo/app.js', 'app.js', 'text/javascript'],
      ['/demo/style.css', 'style.css', 'text/css'],
      ['/demo/gameplay.svg', 'gameplay.svg', 'image/svg+xml'],
    ])
      app.get(url!, (_request, reply) =>
        reply
          .type(type! + '; charset=utf-8')
          .send(
            readFileSync(resolve(projectRoot, 'public/demo', file!), 'utf8'),
          ),
      );
    // Only fictional demo keys/data exist on this isolated instance. Real mode never registers these routes.
    app.get('/api/demo', () => this.snapshot());
    app.post(
      '/api/demo/action',
      { preHandler: requireAdmin },
      async (request) => {
        const body = z
          .object({
            action: z.enum([
              'story',
              'stop',
              'new',
              'seals',
              'date',
              'live',
              'offline',
              'category',
              'followers',
              'approve',
              'reveal',
              'prophet',
              'end',
            ]),
            scenario: z.enum(['category', 'date', 'followers']).optional(),
          })
          .strict()
          .safeParse(request.body);
        if (!body.success)
          throw new CapsuleError(400, 'Choose a demo control.');
        await this.action(body.data.action, body.data.scenario);
        return this.snapshot();
      },
    );
  }
  async initialize(): Promise<void> {
    await this.services.auth.connect('streamer', 'demo-code');
  }
  async ready(): Promise<void> {
    await this.prepare('category');
  }
  snapshot() {
    const capsule = this.capsuleId
      ? this.services.capsules.get(this.capsuleId)
      : null;
    const elapsed =
      this.state === 'running' && this.startedAt !== null
        ? Math.min(storyDurationMs, this.realNow() - this.startedAt)
        : this.elapsed;
    return {
      mode: 'demo',
      state: this.state,
      headline: this.headline,
      error: this.error,
      elapsedMs: elapsed,
      durationMs: storyDurationMs,
      step: this.nextStep,
      totalSteps: storySteps.length,
      clock: new Date(this.clock.now()).toISOString(),
      scenario: this.scenario,
      facts: {
        live: this.twitch.live,
        category: this.twitch.categoryName,
        followers: this.twitch.followers,
      },
      capsule: capsule
        ? {
            id: capsule.id,
            title: capsule.title,
            status: capsule.status,
            sealedCount: capsule.sealedCount,
          }
        : null,
      ceremony: this.services.ceremony.dashboard().state.stage,
      vipCount: this.twitch.vips.size,
      messages: this.twitch.messages.slice(-12),
      links: {
        dashboard:
          this.config.baseUrl + '/dashboard?key=' + this.config.adminKey,
        overlay: this.config.baseUrl + '/overlay?key=' + this.config.overlayKey,
        public: capsule ? this.config.baseUrl + '/c/' + capsule.slug : null,
      },
      adminKey: this.config.adminKey,
    };
  }
  action(
    action: string,
    scenario?: 'category' | 'date' | 'followers',
  ): Promise<void> {
    return this.serial(async () => {
      if (action === 'stop') {
        this.stop();
        return;
      }
      if (this.state === 'running')
        throw new CapsuleError(
          409,
          'Stop the full story before using manual controls.',
        );
      this.error = null;
      switch (action) {
        case 'story':
          this.beginStory();
          break;
        case 'new':
          this.state = 'idle';
          this.startedAt = null;
          this.elapsed = 0;
          this.nextStep = 0;
          await this.prepare(scenario ?? 'category');
          this.headline = 'A fresh capsule is ready for fake seals.';
          break;
        case 'seals':
          for (let i = 0; i < sampleViewers.length; i++) await this.seed(i);
          await this.seals.batcher.flush();
          this.headline =
            this.current().sealedCount + ' sample predictions are sealed.';
          break;
        case 'date': {
          const capsule = this.current();
          if (capsule.triggerType !== 'date')
            throw new CapsuleError(409, 'Create a date capsule first.');
          this.clock.advance(
            Date.parse(capsule.triggerValue) - this.clock.now() + 1000,
          );
          await this.services.triggers.sync();
          this.headline =
            'The date arrived. Opening still waits for a live stream.';
          break;
        }
        case 'live':
          await this.live(true);
          this.headline = 'The simulated channel is live.';
          break;
        case 'offline':
          await this.live(false);
          this.headline = 'The simulated channel is offline.';
          break;
        case 'category':
          this.category();
          this.headline = 'Category changed to Grand Theft Auto VI.';
          break;
        case 'followers':
          this.twitch.followers = 1000;
          await this.services.triggers.follow(demoChannel.id);
          this.headline = 'The follower goal has been reached.';
          break;
        case 'approve':
          this.approve();
          this.headline = 'Pending messages approved. Ready to reveal.';
          break;
        case 'reveal':
          this.services.ceremony.revealNext();
          break;
        case 'prophet':
          await this.prophet();
          break;
        case 'end':
          this.services.ceremony.end();
          break;
        default:
          throw new CapsuleError(400, 'Unknown demo action.');
      }
      this.services.changed();
    });
  }
  private current() {
    const capsule = this.capsuleId
      ? this.services.capsules.get(this.capsuleId)
      : null;
    if (!capsule) throw new CapsuleError(409, 'Create a demo capsule first.');
    return capsule;
  }
  private async prepare(
    scenario: 'category' | 'date' | 'followers',
  ): Promise<void> {
    if (this.services.ceremony.dashboard().active) this.services.ceremony.end();
    for (const capsule of this.services.capsules.list())
      if (['sealing', 'locked', 'ready'].includes(capsule.status))
        this.services.capsules.changeStatus(capsule.id, 'archive');
    this.twitch.resetFacts();
    await this.services.triggers.sync(false);
    this.services.connection.setLive(false);
    const common = { settings: { vip_reward: true, vip_days: 30 } };
    const input =
      scenario === 'date'
        ? {
            ...common,
            title: 'Tomorrow’s predictions',
            triggerType: 'date',
            triggerValue: new Date(this.clock.now() + 86400_000).toISOString(),
          }
        : scenario === 'followers'
          ? {
              ...common,
              title: 'Our first thousand followers',
              triggerType: 'followers',
              triggerValue: 1000,
            }
          : {
              ...common,
              title: 'GTA VI Predictions',
              triggerType: 'category',
              triggerValue: {
                category_id: demoCategoryId,
                category_name: demoCategory.name,
              },
            };
    const capsule = this.services.capsules.create(input, demoChannel);
    this.capsuleId = capsule.id;
    this.scenario = scenario;
    this.seeded.clear();
    this.services.log.write('demo.capsule_created', {
      capsuleId: capsule.id,
      scenario,
    });
    this.services.changed();
  }
  private async seed(index: number): Promise<void> {
    if (this.seeded.has(index)) return;
    if (this.current().status !== 'sealing')
      throw new CapsuleError(
        409,
        'This capsule is no longer collecting seals. Create a new one to collect more.',
      );
    const sample = sampleViewers[index];
    if (!sample) throw new CapsuleError(400, 'Unknown sample viewer.');
    await this.commands.receive(
      {
        broadcaster_user_id: demoChannel.id,
        chatter_user_id: String(20001 + index),
        chatter_user_login: sample[0].toLowerCase(),
        chatter_user_name: sample[0],
        message_id: randomUUID(),
        message: { text: '!seal ' + sample[1] },
        badges: [],
      },
      demoChannel.id,
    );
    this.seeded.add(index);
  }
  private async live(value: boolean): Promise<void> {
    this.twitch.live = value;
    this.services.connection.setLive(value);
    await this.services.triggers.stream(demoChannel.id, value);
    this.services.log.write(value ? 'stream.online' : 'stream.offline', {
      live: value,
      simulated: true,
    });
  }
  private category(): void {
    this.twitch.categoryId = demoCategoryId;
    this.twitch.categoryName = demoCategory.name;
    this.services.triggers.category(
      demoChannel.id,
      demoCategoryId,
      demoCategory.name,
    );
    this.services.log.write('channel.update', {
      categoryId: demoCategoryId,
      categoryName: demoCategory.name,
      simulated: true,
    });
  }
  private approve(): void {
    for (const seal of this.services.ceremony.queue('pending', 0, 100).seals)
      this.services.ceremony.moderate(seal.id, 'approved');
  }
  private async prophet(): Promise<void> {
    const id = this.services.ceremony.state().recentSealIds.at(-1);
    if (!id)
      throw new CapsuleError(409, 'Reveal an approved prediction first.');
    await this.services.prophets.mark(id);
  }
  private beginStory(): void {
    this.stopTimer();
    this.startedAt = this.realNow();
    this.elapsed = 0;
    this.nextStep = 0;
    this.state = 'running';
    this.headline = 'The story is starting…';
    this.timer = setInterval(() => {
      void this.tickStory();
    }, 250);
    this.timer.unref();
  }
  tickStory(): Promise<void> {
    return this.serial(async () => {
      if (this.state !== 'running' || this.startedAt === null) return;
      try {
        this.elapsed = this.realNow() - this.startedAt;
        while (this.nextStep < storySteps.length) {
          const step = storySteps[this.nextStep]!;
          if (step.at > this.elapsed) break;
          switch (step.action) {
            case 'prepare':
              await this.prepare('category');
              break;
            case 'seal':
              await this.seed('index' in step ? step.index : 0);
              break;
            case 'lock':
              this.services.capsules.changeStatus(this.current().id, 'lock');
              break;
            case 'time':
              this.clock.advance(7 * 86400_000);
              await this.services.triggers.sync(false);
              break;
            case 'live':
              await this.live(true);
              break;
            case 'category':
              this.category();
              break;
            case 'approve':
              this.approve();
              break;
            case 'reveal':
              this.services.ceremony.revealNext();
              break;
            case 'prophet':
              await this.prophet();
              break;
            case 'end':
              this.services.ceremony.end();
              break;
            case 'complete':
              this.state = 'completed';
              this.stopTimer();
              break;
          }
          this.headline = step.label;
          this.nextStep++;
          this.services.log.write('demo.story_step', {
            step: this.nextStep,
            label: step.label,
          });
        }
      } catch {
        this.state = 'error';
        this.error =
          'The story could not continue. Stop, create a new capsule, and try again.';
        this.stopTimer();
      }
      this.services.changed();
    });
  }
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private stop(): void {
    this.stopTimer();
    if (this.startedAt !== null)
      this.elapsed = Math.min(storyDurationMs, this.realNow() - this.startedAt);
    this.state = 'stopped';
    this.headline =
      'Story stopped. Continue with the manual controls; existing seals are preserved.';
    this.services.changed();
  }
  async close(): Promise<void> {
    this.stopTimer();
    this.closed = true;
    await this.tail;
    await this.seals.close();
  }
}

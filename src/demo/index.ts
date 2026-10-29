import { createDemoServer } from './server.js';
async function main() {
  const args = process.argv.slice(2);
  const raw =
    args.length === 1 && args[0]?.startsWith('--port=')
      ? args[0].slice(7)
      : undefined;
  if (args.length && raw === undefined)
    throw new Error('Usage: npm run demo -- --port=3001');
  const ports = raw !== undefined ? [Number(raw)] : [3000, 3001];
  for (const port of ports) {
    const demo = createDemoServer({ port });
    try {
      await demo.app.listen({ host: '127.0.0.1', port });
      const close = () => {
        void demo.app.close();
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
      console.log(
        'Time Capsule — DEMO (fake Twitch only)\nDemo: ' +
          demo.config.baseUrl +
          '/demo\nFresh demo data: ' +
          demo.config.dataDir +
          '\nNo .env, Twitch account, real messages, or real VIP changes.',
      );
      return;
    } catch (error) {
      await demo.app.close();
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EADDRINUSE' &&
        port !== ports.at(-1)
      ))
        throw error;
    }
  }
}
main().catch(() => {
  console.error(
    'Demo could not start. Use npm run demo -- --port=3002 if ports 3000 and 3001 are busy. Check Node and local storage permissions.',
  );
  process.exitCode = 1;
});

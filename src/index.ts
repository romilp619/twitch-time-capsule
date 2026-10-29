import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);
  const shutdown = () => {
    void app.close().catch(() => {
      console.error('Unable to close the server cleanly.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(
      `Time Capsule - Phase 8\nHealth: ${config.baseUrl}/health\nDashboard: ${config.baseUrl}/dashboard?key=${config.adminKey}\nOBS overlay: ${config.baseUrl}/overlay?key=${config.overlayKey}\nSQLite: ${config.databasePath}`,
    );
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  // Only config validation messages are safe to print; other errors may include secrets.
  const message =
    error instanceof Error &&
    (error.message.startsWith('Invalid configuration') ||
      error.message.startsWith('Cannot read data/keys.json') ||
      error.message.startsWith('Cannot read data/tokens.json'))
      ? error.message
      : 'Unable to start Time Capsule. Check the port, storage permissions, and installed dependencies.';
  console.error(message);
  process.exitCode = 1;
});

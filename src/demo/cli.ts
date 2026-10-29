import { EventSubClient, type EventSubscription } from '../twitch/eventsub.js';
import { TwitchError } from '../twitch/http.js';
// Account-free check of the production EventSub client against Twitch CLI.
const subscription: EventSubscription = {
  type: 'channel.update',
  version: '2',
  condition: { broadcaster_user_id: '10001' },
};
const client = new EventSubClient([subscription], {
  url: 'ws://127.0.0.1:8080/ws',
  onNotice: (type, message) => console.log(type + ': ' + message),
  onNotification: (notification) => {
    console.log(
      'CLI notification: ' +
        JSON.stringify({
          type: notification.subscription.type,
          event: notification.event,
        }),
    );
  },
  subscribe: async (sessionId, event) => {
    const response = await fetch(
      'http://127.0.0.1:8080/eventsub/subscriptions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': 'local-cli-client',
          Authorization: 'Bearer local-cli-token',
        },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          ...event,
          transport: { method: 'websocket', session_id: sessionId },
        }),
      },
    );
    if (!response.ok)
      throw new TwitchError(
        502,
        'The local Twitch CLI rejected the mock subscription.',
      );
    console.log('CLI subscription ready: ' + event.type + ' v' + event.version);
  },
});
client.start();
process.once('SIGINT', () => client.stop());
process.once('SIGTERM', () => client.stop());
console.log(
  'Listening to the local Twitch CLI on port 8080. No Twitch account is used.',
);

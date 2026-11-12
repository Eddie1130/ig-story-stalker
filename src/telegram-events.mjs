import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomic } from './error-monitor.mjs';

export const eventDirectory = env => path.join(env.IG_STATE_DIR || '/app/state', 'telegram-events');
export function publishEvent(dir, event, identity = randomUUID()) {
  const file = path.join(dir, createHash('sha256').update(identity).digest('hex') + '.json');
  atomic(file, { version: 1, ...event });
}
export function notificationPublisher(env, aliases = () => []) {
  const dir = eventDirectory(env);
  return {
    aliases,
    stories(username, target, stories, at = Date.now()) {
      publishEvent(dir, { type: 'stories', username, target, usernames: aliases(target), stories, at });
    },
    media(username, target, method, body, metadata) {
      publishEvent(dir, { type: 'media', username, target, usernames: aliases(target), method, body, ...metadata, at: metadata.detectedAt }, `${target}:${metadata.id}`);
    },
  };
}
export function controlHeartbeat(env) {
  try {
    const health = JSON.parse(fs.readFileSync(path.join(env.IG_CONTROL_DIR || '/app/control', 'health.json'), 'utf8'));
    return Number.isFinite(health.at) && Math.abs(Date.now() - health.at) < 120000 && Number.isFinite(health.lastPollAt) && Math.abs(Date.now() - health.lastPollAt) < 120000 ? health : null;
  } catch { return null; }
}

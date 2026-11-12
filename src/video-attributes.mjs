import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

// Telegram needs display dimensions, including pixel aspect ratio and rotation.
export function displayAttributes(data) {
  const stream = data?.streams?.[0];
  if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0) return null;
  let width = stream.width, height = stream.height;
  const sar = stream.sample_aspect_ratio;
  if (sar && sar !== 'N/A' && sar !== '0:1') {
    if (!/^\d+:\d+$/.test(sar)) return null;
    const [numerator, denominator] = sar.split(':').map(Number);
    if (!numerator || !denominator) return null;
    width = Math.round(width * numerator / denominator);
  }
  const matrix = stream.side_data_list?.find(item => item.rotation !== undefined);
  const rotation = Number(matrix?.rotation ?? stream.tags?.rotate ?? 0);
  const turns = rotation / 90;
  if (!Number.isFinite(turns) || Math.abs(turns - Math.round(turns)) > 0.001) return null;
  if (Math.abs(Math.round(turns) % 2) === 1) [width, height] = [height, width];
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 32768)) return null;
  const attributes = { width, height };
  const seconds = Number(stream.duration == null || stream.duration === 'N/A' ? data.format?.duration : stream.duration);
  if (Number.isFinite(seconds) && seconds >= 0 && Math.ceil(seconds) < 2 ** 31) attributes.duration = Math.ceil(seconds);
  return attributes;
}

export async function videoAttributes(filename) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov',
      '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,sample_aspect_ratio,duration:stream_tags=rotate:stream_side_data=rotation:format=duration',
      '-of', 'json', path.resolve(filename),
    ], { timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8' });
    return displayAttributes(JSON.parse(stdout));
  } catch {
    return null;
  }
}

export function previewSize({ width, height }) {
  const factor = Math.min(1, 320 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

// Render an upright JPEG with square pixels; never crop or alter the video.
export async function videoPreview(filename, attributes) {
  try {
    const size = previewSize(attributes);
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file', '-f', 'mov',
      '-i', path.resolve(filename), '-map', '0:v:0', '-frames:v', '1', '-an',
      '-vf', `scale=${size.width}:${size.height},setsar=1`,
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1',
    ], { timeout: 15000, maxBuffer: 256 * 1024, encoding: 'buffer' });
    if (stdout.length < 4 || stdout.length >= 200000 || stdout[0] !== 255 || stdout[1] !== 216 || stdout.at(-2) !== 255 || stdout.at(-1) !== 217) return null;
    return stdout;
  } catch {
    return null;
  }
}

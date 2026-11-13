import fs from 'node:fs';
import path from 'node:path';
import { mediaExtension } from './story-archive.mjs';

export function manualPath(root, relative, { mkdir = false, directory = false } = {}) {
  if (!path.isAbsolute(root) || typeof relative !== 'string' || !(relative.startsWith('manual/') || relative.startsWith('instagram/manual/')) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || relative.includes('\0')) throw Error('MANUAL_UNSAFE_PATH');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('MANUAL_STORAGE_UNAVAILABLE');
  // Historical manifests retain their original relative paths after migration.
  if (relative.startsWith('manual/')) {
    const migrated = path.join(root, 'instagram', 'manual');
    const legacy = path.join(root, 'manual');
    if (fs.existsSync(migrated) && fs.existsSync(legacy)) throw Error('MANUAL_UNSAFE_PATH');
    if (fs.existsSync(migrated)) relative = 'instagram/' + relative;
  }
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const isDir = i < parts.length - 1 || directory;
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (mkdir && isDir) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
      else if (isDir) throw error;
      else continue;
    }
    if (stat.isSymbolicLink() || (isDir && !stat.isDirectory()) || (!isDir && !stat.isFile())) throw Error('MANUAL_UNSAFE_PATH');
  }
  return current;
}
export function validManualFile(root, record) {
  const file = manualPath(root, record.relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !Number.isSafeInteger(record.bytes) || stat.size !== record.bytes || stat.size < 12) throw Error('MANUAL_FILE_INCOMPLETE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(32), count = fs.readSync(fd, bytes, 0, 32, 0);
    if (mediaExtension(bytes.subarray(0, count), record.mediaType) !== path.extname(file)) throw Error('MANUAL_FILE_INCOMPLETE');
  } finally { fs.closeSync(fd); }
  return file;
}

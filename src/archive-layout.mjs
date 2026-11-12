import fs from 'node:fs';
import path from 'node:path';
import { atomic, load } from './error-monitor.mjs';

const groups = ['stories', 'posts', 'highlight'];
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function directory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('ARCHIVE_LAYOUT_UNSAFE_DIRECTORY');
}

// Paths inside archive/catalog histories stay relative to each account's root.
// A journal written before renames lets a restart finish an interrupted migration.
export function accountArchiveRoot(root, stateDir, target, username, ownerNames = {}) {
  if (!path.isAbsolute(root) || !/^\d+$/.test(target) ||
      !/^[A-Za-z0-9_.]{1,30}$/.test(username) || ['.', '..'].includes(username)) throw Error('ARCHIVE_LAYOUT_INVALID_CONFIG');
  directory(root); // A missing download mount must not be silently recreated.
  const file = path.join(stateDir, 'archive-layout.json');
  const required = file + '.required';
  if (exists(required) && !exists(file)) throw Error('ARCHIVE_LAYOUT_HISTORY_MISSING');
  const layout = load(file, { version: 1, accounts: {}, migration: null, legacyChecked: false });
  if (layout.version !== 1 || !layout.accounts || Array.isArray(layout.accounts) || typeof layout.accounts !== 'object' ||
      typeof layout.legacyChecked !== 'boolean') throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
  for (const [id, folder] of Object.entries(layout.accounts)) {
    if (!/^\d+$/.test(id) || typeof folder !== 'string' || !/^[A-Za-z0-9_.]{1,60}$/.test(folder) ||
        ['.', '..', ...groups].includes(folder)) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
  }
  if (new Set(Object.values(layout.accounts)).size !== Object.values(layout.accounts).length) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
  if (!layout.accounts[target]) {
    const name = groups.includes(username) ? `${username}_${target}` : username;
    if (Object.values(layout.accounts).includes(name)) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
    layout.accounts[target] = name;
  }
  if (!layout.legacyChecked) {
    const legacy = groups.filter(group => exists(path.join(root, group)));
    if (legacy.length) {
      const owners = new Set(fs.readdirSync(stateDir).flatMap(name => {
        const match = /^(?:archive|catalog|watch-media)-(\d+)\.json(?:\.required)?$/.exec(name);
        return match ? [match[1]] : [];
      }));
      if (owners.size !== 1) throw Error('ARCHIVE_MIGRATION_OWNER_AMBIGUOUS');
      const owner = [...owners][0];
      const ownerName = ownerNames[owner] || owner;
      layout.accounts[owner] ||= owner === target ? layout.accounts[target] : groups.includes(ownerName) ? `${ownerName}_${owner}` : ownerName;
      if (new Set(Object.values(layout.accounts)).size !== Object.values(layout.accounts).length) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
      layout.migration = { owner, groups: legacy };
      const destination = path.join(root, layout.accounts[owner]);
      if (exists(destination)) {
        directory(destination);
        if (legacy.some(group => exists(path.join(destination, group)))) throw Error('ARCHIVE_MIGRATION_DESTINATION_EXISTS');
      }
      for (const group of legacy) directory(path.join(root, group));
    }
    layout.legacyChecked = true;
    atomic(file, layout);
  }
  if (layout.migration) {
    const { owner, groups: pending } = layout.migration;
    if (!layout.accounts[owner] || !Array.isArray(pending) || pending.some(group => !groups.includes(group))) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
    const destination = path.join(root, layout.accounts[owner]);
    if (exists(destination)) directory(destination);
    else fs.mkdirSync(destination);
    for (const group of pending) {
      const source = path.join(root, group), dest = path.join(destination, group);
      if (exists(source)) {
        directory(source);
        if (exists(dest)) throw Error('ARCHIVE_MIGRATION_DESTINATION_EXISTS');
        fs.renameSync(source, dest);
      } else if (!exists(dest)) throw Error('ARCHIVE_MIGRATION_SOURCE_MISSING');
      directory(dest);
    }
    layout.migration = null;
  }
  const destination = path.join(root, layout.accounts[target]);
  if (exists(destination)) directory(destination);
  else fs.mkdirSync(destination);
  atomic(file, layout);
  if (!exists(required)) fs.writeFileSync(required, 'required', { mode: 0o600, flag: 'wx' });
  return destination;
}

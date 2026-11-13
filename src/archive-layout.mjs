import fs from 'node:fs';
import path from 'node:path';
import { atomic, load } from './error-monitor.mjs';

const groups = ['stories', 'posts', 'highlight'];
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function directory(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('ARCHIVE_LAYOUT_UNSAFE_DIRECTORY');
}

// The state directory is shared by workers; serialize all layout updates.
// A lock left by a terminated process must be removed only after stopping all writers.
function withLayoutLock(stateDir, action) {
  const lock = path.join(stateDir, '.instagram-layout.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('ARCHIVE_LAYOUT_LOCKED'); throw error; }
  try { return action(); } finally { fs.rmdirSync(lock); }
}
const folded = name => name.toLowerCase();
function findName(directoryPath, name) {
  return fs.readdirSync(directoryPath).find(entry => folded(entry) === folded(name));
}

// Each rename is recorded before it starts. A restart can finish a rename
// even when the process stopped after the filesystem changed.
function migrateInstagramLayoutUnlocked(root, stateDir, account = null) {
  if (!path.isAbsolute(root)) throw Error('ARCHIVE_LAYOUT_INVALID_CONFIG');
  directory(root);
  const file = path.join(stateDir, 'instagram-layout.json');
  const required = file + '.required';
  if (exists(required) && !exists(file)) throw Error('ARCHIVE_LAYOUT_HISTORY_MISSING');
  const state = load(file, { version: 1, pending: null, completed: [] });
  if (state?.version !== 1 || (state.pending !== null && (typeof state.pending !== 'string' || !/^[A-Za-z0-9_.]{1,60}$/.test(state.pending) || ['.', '..', 'instagram', 'x'].includes(folded(state.pending))))) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
  state.completed ??= [];
  if (!Array.isArray(state.completed) || state.completed.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.]{1,60}$/.test(name))) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
  const platform = path.join(root, 'instagram');
  if (exists(platform)) directory(platform); else fs.mkdirSync(platform);
  const migrate = name => {
    const source = path.join(root, name), destination = path.join(platform, name);
    if (!state.pending) {
      if (state.completed.includes(name)) return;
      if (!exists(source)) {
        if (findName(platform, name)) throw Error('ARCHIVE_MIGRATION_DESTINATION_EXISTS');
        state.completed.push(name); atomic(file, state); return;
      }
      directory(source);
      if (findName(platform, name)) throw Error('ARCHIVE_MIGRATION_DESTINATION_EXISTS');
      state.pending = name; atomic(file, state);
      if (!exists(required)) fs.writeFileSync(required, 'required', { mode: 0o600, flag: 'wx' });
    }
    if (exists(source)) {
      directory(source);
      if (findName(platform, name)) throw Error('ARCHIVE_MIGRATION_DESTINATION_EXISTS');
      fs.renameSync(source, destination);
    } else if (!exists(destination)) throw Error('ARCHIVE_MIGRATION_SOURCE_MISSING');
    directory(destination);
    state.pending = null; if (!state.completed.includes(name)) state.completed.push(name); atomic(file, state);
  };
  if (state.pending) migrate(state.pending);
  const old = load(path.join(stateDir, 'archive-layout.json'), null);
  if (old?.accounts && Object.values(old.accounts).some(name => typeof name === 'string' && folded(name) === 'manual') && findName(root, 'manual')) throw Error('ARCHIVE_MIGRATION_OWNER_AMBIGUOUS');
  migrate('manual');
  // Include previously monitored accounts, even if they are no longer active.
  // Finish the older groups migration first before moving those account roots.
  const accounts = old?.legacyChecked && !old?.migration && old?.accounts ? Object.values(old.accounts) : [];
  if (account && !accounts.includes(account)) accounts.push(account);
  for (const name of accounts) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.]{1,60}$/.test(name) || ['.', '..', ...groups].includes(folded(name))) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
    if (['manual', 'instagram', 'x'].includes(folded(name))) throw Error('ARCHIVE_MIGRATION_OWNER_AMBIGUOUS');
    if (name === account || exists(path.join(root, name))) migrate(name);
  }
}

export function migrateInstagramLayout(root, stateDir, account = null) {
  return withLayoutLock(stateDir, () => migrateInstagramLayoutUnlocked(root, stateDir, account));
}

// Paths inside archive/catalog histories stay relative to each account's root.
// A journal written before renames lets a restart finish an interrupted migration.
function accountArchiveRootUnlocked(root, stateDir, target, username, ownerNames = {}) {
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
        ['.', '..', ...groups].includes(folded(folder))) throw Error('ARCHIVE_LAYOUT_INVALID_STATE');
  }
  if (new Set(Object.values(layout.accounts).map(folded)).size !== Object.values(layout.accounts).length) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
  if (!layout.accounts[target]) {
    const name = [...groups, 'manual', 'instagram', 'x'].includes(folded(username)) ? `${username}_${target}` : username;
    if (Object.values(layout.accounts).some(folder => folded(folder) === folded(name))) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
    const platform = path.join(root, 'instagram');
    if (exists(platform)) { directory(platform); if (findName(platform, name)) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION'); }
    // An unregistered root folder could belong to another application.
    if (findName(root, name) && !groups.some(group => exists(path.join(root, group)))) throw Error('ARCHIVE_MIGRATION_OWNER_AMBIGUOUS');
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
      layout.accounts[owner] ||= owner === target ? layout.accounts[target] : [...groups, 'manual', 'instagram', 'x'].includes(folded(ownerName)) ? `${ownerName}_${owner}` : ownerName;
      if (new Set(Object.values(layout.accounts).map(folded)).size !== Object.values(layout.accounts).length) throw Error('ARCHIVE_LAYOUT_ACCOUNT_COLLISION');
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
  atomic(file, layout);
  migrateInstagramLayoutUnlocked(root, stateDir, layout.accounts[target]);
  const destination = path.join(root, 'instagram', layout.accounts[target]);
  if (exists(destination)) directory(destination);
  else fs.mkdirSync(destination);
  atomic(file, layout);
  if (!exists(required)) fs.writeFileSync(required, 'required', { mode: 0o600, flag: 'wx' });
  return destination;
}

export function accountArchiveRoot(root, stateDir, target, username, ownerNames = {}) {
  return withLayoutLock(stateDir, () => accountArchiveRootUnlocked(root, stateDir, target, username, ownerNames));
}

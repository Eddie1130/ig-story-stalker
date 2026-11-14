import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomic, load } from './error-monitor.mjs';

export function syncDirectory(dir) {
  const fd=fs.openSync(dir,'r');
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}

// Immutable payloads are committed before worker.json references them. Only the
// small retry/recipient records stay in memory while a history queue is waiting.
export class XPendingStore {
  constructor(dir) {
    this.dir=dir;
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const stat=fs.lstatSync(dir);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('X_UNSAFE_PATH');
    syncDirectory(path.dirname(dir));
    this.dirty=true;
  }
  file(ref) {
    if(typeof ref!=='string'||!/^[a-f0-9]{64}$/.test(ref))throw Error('X_PENDING_REFERENCE_INVALID');
    return path.join(this.dir,ref+'.json');
  }
  put(name,key,event) {
    const ref=createHash('sha256').update(JSON.stringify([name,key,event])).digest('hex');
    const file=this.file(ref);
    if(!fs.existsSync(file)) {atomic(file,event);this.dirty=true;}
    else this.check(file);
    return ref;
  }
  check(file) {
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>20_000_000)throw Error('X_PENDING_PAYLOAD_INVALID');
  }
  read(ref) {
    const file=this.file(ref);this.check(file);
    const event=load(file,null);
    if(!event||typeof event!=='object'||Array.isArray(event))throw Error('X_PENDING_PAYLOAD_INVALID');
    return event;
  }
  remove(ref) {
    fs.rmSync(this.file(ref),{force:true});
  }
  flush() {
    // File fsync alone does not persist rename. Commit new payload names before
    // worker.json can reference them, including after a previous interrupted run.
    if(!this.dirty)return;
    syncDirectory(this.dir);
    this.dirty=false;
  }
  collect(references) {
    // Recover payloads left by a crash between payload/state commits or between
    // the completed state checkpoint and unlink. Ignore unrelated filenames.
    for(const filename of fs.readdirSync(this.dir)) {
      const match=/^([a-f0-9]{64})\.json$/.exec(filename);
      if(match&&!references.has(match[1]))this.remove(match[1]);
    }
  }
}

import { simpleXHistory } from './x-status.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { atomic, load, log } from './error-monitor.mjs';
import { readSettings, settingsFile } from './telegram-settings.mjs';
import { XArchive } from './x-archive.mjs';
import { XPendingStore, syncDirectory } from './x-pending-store.mjs';
import { normalizeFxTimeline, normalizeFxPost, normalizeHistory, parseXLink, validXUsername } from './x-model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const eventKey = event => `${event.kind}:${event.statusId}`;
const nextDay = now => new Date(now + 86400000).toISOString().slice(0,10);
const day = now => new Date(now).toISOString().slice(0,10);
const active = status => ['queued','working','importing','retry'].includes(status);
const safeReason = error => /^[A-Z][A-Z0-9_]{1,90}$/.test(error?.message || '') ? error.message : 'X_OPERATION_FAILED';
const recoverable = reason => /^(X_HTTP_(404|408|429|5\d\d)|X_NETWORK_ERROR|X_MEDIA_DOWNLOAD_INCOMPLETE|X_HISTORY_PROCESS_FAILED|X_HISTORY_TIMEOUT)$/.test(reason);
const pythonScript = name => fileURLToPath(new URL('../' + name, import.meta.url));

// Every mutable queue has one writer: this process. Telegram owns settings.json.
export class XWatcher {
  constructor({ stateDir, root, settings, env = process.env, fetchImpl = fetch, archive, historyRunner }) {
    Object.assign(this, { stateDir, root, settings, env, fetchImpl, historyRunner });
    this.dir = path.join(stateDir,'x'); this.file = path.join(this.dir,'worker.json');
    this.archive = archive || new XArchive({root,fetchImpl});
    const interval = Number(env.X_CHECK_INTERVAL_SECONDS || 300);
    if (!Number.isInteger(interval) || interval < 60 || interval > 86400) throw Error('X_INVALID_INTERVAL');
    this.interval = interval * 1000;
    const tick=Number(env.X_WORK_INTERVAL_SECONDS||5);
    if(!Number.isInteger(tick)||tick<1||tick>60)throw Error('X_INVALID_WORK_INTERVAL');
    this.workInterval=tick*1000;
    if (fs.existsSync(this.file+'.required') && !fs.existsSync(this.file)) throw Error('X_WORKER_HISTORY_MISSING');
    this.state = load(this.file,{version:1,accounts:{},history:{},requests:{},pool:{active:0,locked:0}});
    if (![1,2].includes(this.state?.version) || !this.state.accounts || !this.state.history || !this.state.requests ||
        [this.state.accounts,this.state.history,this.state.requests].some(v=>typeof v!=='object'||Array.isArray(v))) throw Error('X_WORKER_HISTORY_INVALID');
    for (const [name,a] of Object.entries(this.state.accounts)) {
      if (!validXUsername(name) || !a || typeof a.baseline!=='boolean' || !a.seen || !a.pending || !a.generations ||
          [a.seen,a.pending,a.generations].some(v=>typeof v!=='object'||Array.isArray(v))) throw Error('X_WORKER_HISTORY_INVALID');
    }
    for (const [id,j] of Object.entries(this.state.history)) {
      if (!/^[a-f0-9-]{36}$/.test(id) || !j || j.id!==id || !validXUsername(j.username) || !Array.isArray(j.requestIds) || !Array.isArray(j.userIds)) throw Error('X_WORKER_HISTORY_INVALID');
      if (['working','importing'].includes(j.status)) j.status='queued';
    }
    this.pendingStore=new XPendingStore(path.join(this.dir,'pending'));
    for(const [name,a] of Object.entries(this.state.accounts))for(const [key,p] of Object.entries(a.pending)) {
      if(!p||typeof p!=='object'||Array.isArray(p))throw Error('X_WORKER_HISTORY_INVALID');
      if(p.event) {
        p.eventRef=this.pendingStore.put(name,key,p.event);
        delete p.event;
      } else this.pendingStore.file(p.eventRef);
    }
    this.state.version=2;
    this.persist();
    this.pendingStore.collect(new Set(Object.values(this.state.accounts).flatMap(a=>Object.values(a.pending).map(p=>p.eventRef))));
  }
  pendingRecord(name,key,event,metadata) {
    return {...metadata,eventRef:this.pendingStore.put(name,key,event)};
  }
  persist() {
    this.pendingStore?.flush();
    atomic(this.file,this.state);
    syncDirectory(this.dir);
    if (!fs.existsSync(this.file+'.required')) fs.writeFileSync(this.file+'.required','required',{flag:'wx',mode:0o600});
  }
  subscriptions(name) {
    const s=this.settings();
    return s.allowedIds.flatMap(userId=>{
      const sub=Object.hasOwn(s.users[userId]?.xTargets || {},name) ? s.users[userId].xTargets[name] : null;
      return sub ? [{userId,sub}] : [];
    });
  }
  names() {
    const s=this.settings();
    return [...new Set(s.allowedIds.flatMap(id=>Object.keys(s.users[id]?.xTargets || {})))].filter(validXUsername);
  }
  account(name) {
    if(!validXUsername(name))throw Error('X_INVALID_USERNAME');
    if(!Object.hasOwn(this.state.accounts,name))Object.defineProperty(this.state.accounts,name,{value:{baseline:false,seen:{},pending:{},generations:{},failures:0,nextAt:0,lastSuccess:0},enumerable:true,writable:true,configurable:true});
    return this.state.accounts[name];
  }
  emit(event,identity) {
    const id=hash(identity),dir=path.join(this.dir,'events');
    atomic(path.join(dir,id+'.json'),{version:1,id,...event});
    syncDirectory(dir);syncDirectory(this.dir);
  }
  notice(text,name,identity=randomUUID(),userIds,metadata={}) {
    const ids=userIds || (name ? this.subscriptions(name).map(s=>s.userId) : [this.settings().ownerId]);
    const at=Math.max(Date.now(),(this.state.lastNoticeAt||0)+1);this.state.lastNoticeAt=at;
    this.emit({type:'notice',at,...metadata,...(name?{username:name}:{}),text,recipients:[...new Set(ids)].map(userId=>({userId}))},identity);
  }
  async json(url) {
    let response;
    try { response=await this.fetchImpl(url,{redirect:'error',headers:{Accept:'application/json','User-Agent':'ig-x-monitor/1.0'},signal:AbortSignal.timeout(30000)}); }
    catch { throw Error('X_NETWORK_ERROR'); }
    if (!response.ok) throw Error(`X_HTTP_${response.status}`);
    const max=20_000_000;
    if (Number(response.headers.get('content-length'))>max) throw Error('X_RESPONSE_TOO_LARGE');
    const chunks=[]; let bytes=0;
    for await (const chunk of response.body) { bytes+=chunk.length;if(bytes>max)throw Error('X_RESPONSE_TOO_LARGE');chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('X_INVALID_RESPONSE'); }
  }
  enqueueHistory({username,start,end,userId,requestId,gap=false},now) {
    // Share a running full-history job; narrower requests already fit its range.
    let job=Object.values(this.state.history).find(j=>j.username===username && active(j.status) && !j.cancelRequested &&
      ((!j.start || (start && j.start<=start)) && j.end >= (end || nextDay(now))));
    if (!job) {
      job={id:randomUUID(),username,...(start?{start}:{}),end:end||nextDay(now),at:now,status:'queued',requestIds:[],userIds:[],gap,attempts:0};
      this.state.history[job.id]=job;
    }
    if(requestId&&!job.requestIds.includes(requestId))job.requestIds.push(requestId);
    if(userId&&!job.userIds.includes(userId))job.userIds.push(userId);
    if(gap)job.gap=true;
    return job;
  }
  historyReport(job,now=Date.now()) {
    let progress={};
    try { progress=load(path.join(this.dir,'progress',job.id+'.json'),{}) || {}; }
    catch { progress={stage:'progress_unavailable'}; }
    const account=this.account(job.username);
    let archive;
    if(job.archiveKeysReady&&Array.isArray(job.archiveKeys)) {
      const done=job.archiveKeys.filter(key=>account.seen[key]&&!account.pending[key]).length;
      archive={total:job.archiveKeys.length,done,remaining:job.archiveKeys.length-done,
        failed:job.archiveKeys.filter(key=>account.pending[key]?.failed).length,unit:'post'};
    }
    if(archive&&!Number.isFinite(job.archiveStartedAt)){job.archiveStartedAt=now;job.archiveStartedDone=archive.done;}
    const terminal=['needs_start','failed','cancelled'].includes(job.status);
    const phase=terminal?job.status:job.status==='retry'?'waiting':job.status==='queued'?'queued':
      job.status==='importing'?'importing':job.reported?'finished':job.phase==='rendering'?'rendering':
      job.fetchDone?'archive':progress.lastWorkStage||progress.phase||progress.stage;
    return {version:1,id:job.id,username:job.username,status:job.status,at:now,requestedAt:job.at,start:job.start||progress.start,end:job.end,
      gap:!!job.gap&&!job.requestIds.length,reason:job.reason,retryAt:job.retryAt,posts:job.posts || progress.posts || 0,
      phase,archiveStartedAt:job.archiveStartedAt,archiveStartedDone:job.archiveStartedDone,fetchDone:!!job.fetchDone,reported:!!job.reported,importedPosts:job.importedPosts,
      progressUpdatedAt:job.fetchDone?(job.archiveUpdatedAt||progress.at):progress.at,archive,
      progress:{completedWindows:progress.completedWindows??progress.window_status_counts?.done,
        totalWindows:progress.totalWindows,remainingWindows:progress.remainingWindows,
        partialWindows:progress.partialWindows??progress.window_status_counts?.partial,failedWindows:progress.failedWindows??progress.window_status_counts?.failed,
        currentPass:progress.currentPass,windowStart:progress.windowStart,windowEnd:progress.windowEnd,lastWorkStage:progress.lastWorkStage,
        passes:Array.isArray(progress.passes)?progress.passes.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map(({name,total,completed,partial,failed})=>({name,total,completed,partial,failed})):undefined}};
  }
  writeJob(job,now=Date.now()) {
    const report=this.historyReport(job,now);
    for(const id of job.requestIds) atomic(path.join(this.dir,'jobs',id+'.json'),{...report,requestId:id});
    if((!job.gap||job.requestIds.length) && job.userIds.length && (active(job.status)||job.fetchDone&&!job.reported) && !['queued','failed','cancelled','needs_start'].includes(job.status) && now-(job.lastProgressNoticeAt||0)>=60000) {
      this.notice(simpleXHistory(report,now),job.username,`${job.id}:progress:${now}`,job.userIds,{noticeKey:`history:${job.id}`,noticeKind:'progress'});
      job.lastProgressNoticeAt=now;
    }
  }
  syncRequests(now=Date.now()) {
    const s=this.settings();
    let changed=false;
    for(const r of Object.values(s.xRequests || {}).sort((a,b)=>a.at-b.at)) {
      if(this.state.requests[r.id] || !s.allowedIds.includes(r.userId) || !validXUsername(r.username)) continue;
      if(r.type==='history') {
        if(!this.subscriptions(r.username).some(v=>v.userId===r.userId))continue;
        changed=true;
        if((r.end&&r.end>nextDay(now))||(r.start&&r.start>day(now))) {
          this.state.requests[r.id]={status:'failed',reason:'X_INVALID_DATE_RANGE'};
          this.notice('X 歷史回補日期不能超過申請當天。',null,`invalid-date:${r.id}`,[r.userId]);continue;
        }
        const job=this.enqueueHistory({...r,requestId:r.id},now);this.state.requests[r.id]={jobId:job.id};this.writeJob(job,now);
      } else if(r.type==='manual') {this.state.requests[r.id]={status:'queued',attempts:0};changed=true;}
    }
    if(changed)this.persist();
  }
  async pollAccount(name,now) {
    const a=this.account(name);if(now<a.nextAt)return;
    // A stopped container cannot record fetch errors. Infer a gap from its checkpoint.
    if(a.baseline&&a.lastSuccess&&(!(a.consecutiveTransient||a.consecutive404)||now>a.nextAt+this.interval*2)&&now-a.lastSuccess>this.interval*2)a.gapStart ||= a.lastSuccess;
    const subscribers=this.subscriptions(name);
    try {
      const payload=await this.json(`https://api.fxtwitter.com/2/profile/${name}/statuses?count=100&with_replies=1`);
      const rows=normalizeFxTimeline(payload,name);
      const oldGenerations={...a.generations};
      // Use the unfiltered response size: normalization may remove unrelated rows.
      const rawRows=payload.results.flatMap(row=>row?.type==='thread'?row.statuses:[row]);
      const shortTimeline=rows.length>0&&rawRows.length<100;
      const covers=anchor=>shortTimeline||!!(anchor&&rows.some(e=>eventKey(e)===anchor));
      // Recheck old automatic jobs on every successful poll, including after upgrades.
      // A new checkpoint must never dismiss an older unresolved gap.
      for(const job of Object.values(this.state.history)) {
        if(job.username!==name||!job.gap||job.requestIds.length||!['queued','retry'].includes(job.status))continue;
        if(covers(job.gapAnchor)) {
          job.status='cancelled';job.reason='X_GAP_COVERED_BY_TIMELINE';job.reported=true;
        }
      }
      // Snapshot the intent before archiving: interrupted downloads must not lose recipients.
      for(const e of rows) {
        const key=eventKey(e);if(a.seen[key])continue;
        const recipients=a.baseline && !a.gapStart ? subscribers.filter(({userId,sub})=>oldGenerations[userId]===sub.generation &&
          sub.notifications[e.kind]?.enabled && sub.notifications[e.kind].since<=now).map(({userId,sub})=>({userId,generation:sub.generation})) : [];
        a.pending[key]=this.pendingRecord(name,key,e,{at:now,recipients});a.seen[key]=now;
      }
      for(const {userId,sub} of subscribers)a.generations[userId]=sub.generation;
      for(const id of Object.keys(a.generations))if(!subscribers.some(s=>s.userId===id))delete a.generations[id];
      if(a.gapStart) {
        const covered=covers(a.timelineAnchor);
        if(!covered) {
          // Only widen work that has not started; never change a running search's range.
          let job=Object.values(this.state.history).find(j=>j.username===name&&j.gap&&!j.requestIds.length&&
            !j.cancelRequested&&['queued','retry'].includes(j.status));
          if(job) {job.start=job.start<day(a.gapStart)?job.start:day(a.gapStart);job.end=job.end>nextDay(now)?job.end:nextDay(now);}
          else {
            job=this.enqueueHistory({username:name,start:day(a.gapStart),end:nextDay(now),gap:true},now);
            job.gapSince=a.gapStart;job.gapAnchor=a.timelineAnchor;
          }
          job.userIds=[...new Set([...job.userIds,...subscribers.map(s=>s.userId)])];
        }
        if(a.failures>0)this.notice(`X @${name} 監控已恢復；${covered?'近期清單已涵蓋中斷期間':'仍可能有缺漏，已排入監控缺口補抓'}，不逐篇補發通知。`,name,`${name}:recovery:${a.gapStart}`,undefined,{noticeKey:`monitor:${name}`,noticeKind:'recovery'});
        delete a.gapStart;
      }
      const queuedGaps=Object.values(this.state.history).filter(j=>j.username===name&&j.gap&&!j.requestIds.length&&
        !j.cancelRequested&&['queued','retry'].includes(j.status)).sort((left,right)=>left.at-right.at);
      const merged=queuedGaps[0];
      for(const duplicate of queuedGaps.slice(1)) {
        if(duplicate.start<merged.start) {
          merged.start=duplicate.start;merged.gapSince=duplicate.gapSince;merged.gapAnchor=duplicate.gapAnchor;
        } else if(duplicate.start===merged.start&&(!duplicate.gapSince||duplicate.gapSince<(merged.gapSince||Infinity))) {
          merged.gapSince=duplicate.gapSince;merged.gapAnchor=duplicate.gapAnchor;
        }
        if(duplicate.end>merged.end)merged.end=duplicate.end;
        merged.userIds=[...new Set([...merged.userIds,...duplicate.userIds])];
        duplicate.status='cancelled';duplicate.reason='X_GAP_MERGED';duplicate.reported=true;
      }
      // Keep an anchor from the last successful timeline, independent of history imports.
      const latest=rows.filter(e=>e.kind!=='repost'&&Number.isFinite(e.publishedAt))
        .sort((left,right)=>right.publishedAt-left.publishedAt|| (BigInt(left.statusId)>BigInt(right.statusId)?-1:1))[0];
      a.timelineAnchor=latest?eventKey(latest):null;
      a.baseline=true;a.lastSuccess=now;a.nextAt=now+this.interval;a.failures=0;a.consecutive404=0;a.consecutiveTransient=0;delete a.reason;
      this.persist();
    } catch(error) {
      if(error.code)throw error;
      const fetchReason=safeReason(error);
      // Fall back to the saved 404 streak when upgrading existing worker state.
      a.consecutiveTransient=recoverable(fetchReason)?(a.consecutiveTransient??a.consecutive404??0)+1:0;
      a.consecutive404=fetchReason==='X_HTTP_404'?(a.consecutive404||0)+1:0;
      if(recoverable(fetchReason)&&a.consecutiveTransient<3&&a.failures===0) {
        a.nextAt=now+this.interval;
        this.persist();return;
      }
      a.failures++;a.reason=fetchReason;
      if(a.baseline) a.gapStart ||= a.lastSuccess;
      a.nextAt=now+Math.min(3600000,this.interval*2**Math.min(a.failures,6));
      if(a.failures===1)this.notice(`X @${name} 監控異常：${a.reason}。將退避重試。`,name,`${name}:fetch:${now}`,undefined,{noticeKey:`monitor:${name}`,noticeKind:'error'});
      this.persist();
    }
  }
  async archivePending(now) {
    // Prioritize live notifications; reserve capacity for quiet backfill.
    // Retry deadlines and oldest-attempt ordering still apply within each queue.
    const eligible=this.names().flatMap(name=>Object.entries(this.account(name).pending).map(([key,p])=>({name,key,p})))
      .filter(({p})=>now>=(p.retryAt||0)).sort((a,b)=>(a.p.lastAttempt||0)-(b.p.lastAttempt||0)||a.p.at-b.p.at);
    const live=eligible.filter(({p})=>p.recipients.length>0);
    const quiet=eligible.filter(({p})=>p.recipients.length===0);
    const liveCount=Math.min(live.length,quiet.length?49:50);
    const candidates=[...live.slice(0,Math.min(2,liveCount)),...quiet.slice(0,1),
      ...live.slice(2,liveCount),...quiet.slice(1,50-liveCount)];
    const completed=[];let changed=false;
    const deadline=performance.now()+15000;let next=0;
    try {
    const work=async()=>{
      while(next<candidates.length&&!this.stopping&&performance.now()<deadline) {
        const {name,key,p}=candidates[next++];
        changed=true;
        const a=this.account(name);p.lastAttempt=now;
        for(const job of Object.values(this.state.history))if(job.username===name&&job.archiveKeys?.includes(key))job.archiveUpdatedAt=now;
        try {
          const event=p.event||this.pendingStore.read(p.eventRef);
          const result=await this.archive.save(event);
          if(result.errors?.length) throw Error('X_MEDIA_DOWNLOAD_INCOMPLETE');
          if(p.recipients.length)this.emit({type:'post',username:name,kind:event.kind,statusId:event.statusId,publishedAt:event.publishedAt,at:p.at,recipients:p.recipients,result},`${name}:${key}:${p.at}`);
          delete a.pending[key];
          if(p.eventRef)completed.push(p.eventRef);
        } catch(error) {
          p.attempts=(p.attempts||0)+1;p.reason=safeReason(error);
          p.retryAt=now+300000;
          if(p.attempts>=3||['ENOSPC','EACCES','EROFS','X_UNSAFE_PATH'].includes(p.reason)) {
            if(!a.archiveWarned)this.notice(`X @${name} 封存失敗：${p.reason}。內容仍在佇列等待重試。`,name,`${name}:archive:${key}:${now}`,undefined,{noticeKey:`archive:${name}`,noticeKind:'error'});
            a.archiveWarned=true;p.failed=true;
          }
        }
        if(a.archiveWarned&&!Object.values(a.pending).some(item=>item.failed)) {
          this.notice(`X @${name} 封存已恢復。`,name,`${name}:archive-recovery:${now}`,undefined,{noticeKey:`archive:${name}`,noticeKind:'recovery'});a.archiveWarned=false;
        }
      }
    };
    // Drain every in-flight save before committing or reclaiming payloads.
    const results=await Promise.allSettled(Array.from({length:3},()=>work()));
    const rejected=results.find(result=>result.status==='rejected');
    if(rejected)throw rejected.reason;
    } finally {
      // A crash before this checkpoint replays at most 50 idempotent saves.
      // Never unlink payloads until the durable queue no longer references them.
      if(changed)this.persist();
      for(const ref of completed)this.pendingStore.remove(ref);
    }
  }
  async retainLegacyManualRequests(now) {
    if(typeof this.archive.retainManual!=='function')return;
    const settings=this.settings();
    let changed=false;
    for(const request of Object.values(settings.xRequests || {})) {
      const task=this.state.requests[request.id];
      if(request.type!=='manual'||task?.status!=='complete'||task.manualArchiveVersion===1||now<(task.manualArchiveRetryAt||0))continue;
      try {
        const link=parseXLink(request.url),file=path.join(this.dir,'events',hash(`manual:${request.id}`)+'.json');
        if(!fs.existsSync(file))throw Error('X_MANUAL_MIGRATION_EVENT_MISSING');
        const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>4000000)throw Error('X_MANUAL_MIGRATION_EVENT_INVALID');
        const event=load(file,null);
        if(link.kind!=='post'||link.username!==request.username||event?.manual!==true||event.type!=='post'||event.requestId!==request.id||event.userId!==request.userId||event.username!==request.username||event.statusId!==link.statusId||event.result?.username!==request.username||event.result?.contentId!==link.statusId||parseXLink(event.result.url).statusId!==link.statusId)throw Error('X_MANUAL_MIGRATION_EVENT_INVALID');
        await this.archive.retainManual(event.result);
        task.manualArchiveVersion=1;delete task.manualArchiveReason;delete task.manualArchiveRetryAt;
      } catch(error) {
        task.manualArchiveReason=safeReason(error);task.manualArchiveRetryAt=now+300000;
      }
      changed=true;
    }
    if(changed)this.persist();
  }
  async manualRequests(now) {
    await this.retainLegacyManualRequests(now);
    const s=this.settings();
    for(const r of Object.values(s.xRequests || {})) {
      const task=this.state.requests[r.id];
      if(r.type!=='manual'||!task||!['queued','retry'].includes(task.status)||now<(task.retryAt||0)||!s.allowedIds.includes(r.userId))continue;
      try {
        const link=parseXLink(r.url);
        if(link.kind!=='post'||link.username!==r.username)throw Error('X_INVALID_LINK');
        const payload=await this.json(`https://api.fxtwitter.com/${link.username}/status/${link.statusId}`);
        const e=normalizeFxPost(payload,link), result=await this.archive.save(e,{manual:true});
        if(result.errors?.length)throw Error('X_MEDIA_DOWNLOAD_INCOMPLETE');
        this.emit({type:'post',username:e.targetUsername,kind:e.kind,statusId:e.statusId,publishedAt:e.publishedAt,at:r.at,manual:true,requestId:r.id,userId:r.userId,recipients:[{userId:r.userId}],result},`manual:${r.id}`);
        task.status='complete';task.manualArchiveVersion=1;
      } catch(error) {
        task.attempts++;task.reason=safeReason(error);task.retryAt=now+30000;
        task.status=task.attempts>=(recoverable(task.reason)?6:3)?'failed':'retry';
        if(task.status==='failed')this.notice(`X 連結下載失敗：${task.reason}\n${r.url}`,null,`manual-failed:${r.id}`,[r.userId]);
      }
      atomic(path.join(this.dir,'jobs',r.id+'.json'),{...task,requestId:r.id,username:r.username,at:now});
      this.persist();break;
    }
  }
  async importHistory(name,records,now=Date.now(),keepGoing=()=>true,job=null) {
    const a=this.account(name);let count=0;
    const keys=new Set(job?.archiveKeys||[]);
    if(job){job.archiveKeys=[...keys];job.archiveKeysReady=false;job.importedPosts=0;}
    for await(const record of records) {
      if(!keepGoing())throw Error('X_HISTORY_CANCELLED');
      const e=normalizeHistory(record,name);if(!e)continue;
      const key=eventKey(e);
      // Existing daily intent wins: historical imports may never erase its recipients.
      if(!a.seen[key]){a.pending[key]=this.pendingRecord(name,key,e,{at:now,recipients:[]});a.seen[key]=now;}
      if(job&&!keys.has(key)){keys.add(key);job.archiveKeys.push(key);}
      count++;if(job)job.importedPosts=count;
      if(count%100===0){this.persist();if(job)this.writeJob(job);}
    }
    if(job){job.archiveKeysReady=true;job.archiveUpdatedAt=Date.now();}
    this.persist();return count;
  }
  async hydrateArchiveProgress() {
    for(const job of Object.values(this.state.history)) {
      if(!job.fetchDone||job.reported||job.archiveKeysReady||job.archiveHydrationAttempted||!['complete','partial'].includes(job.status))continue;
      job.archiveHydrationAttempted=true;
      try {
        const file=path.join(this.historyDirectory(job.username),`${job.username}_posts.jsonl`);
        if(fs.lstatSync(file).isSymbolicLink())throw Error('X_UNSAFE_PATH');
        const keys=new Set();
        for await(const record of this.historyRecords(file))keys.add(eventKey(normalizeHistory(record,job.username)));
        job.archiveKeys=[...keys];job.archiveKeysReady=true;
      } catch(error) {job.progressError=safeReason(error);}
      this.persist();this.writeJob(job);
    }
  }
  async *historyRecords(file) {
    const input=fs.createReadStream(file);const lines=readline.createInterface({input,crlfDelay:Infinity});
    try { for await(const line of lines)if(line.trim())yield JSON.parse(line); }
    finally { lines.close();input.destroy(); }
  }
  historyDirectory(name) {
    if(!validXUsername(name)||!path.isAbsolute(this.root))throw Error('X_UNSAFE_PATH');
    let current=this.root;
    for(const part of ['', 'x',name]) {
      if(part)current=path.join(current,part);
      if(!fs.existsSync(current))fs.mkdirSync(current,{mode:0o700});
      const st=fs.lstatSync(current);if(st.isSymbolicLink()||!st.isDirectory())throw Error('X_UNSAFE_PATH');
    }
    return current;
  }
  async runHistory(job) {
    const out=this.historyDirectory(job.username), progress=path.join(this.dir,'progress',job.id+'.json');
    const args=[pythonScript('x_history_worker.py'),'history','--username',job.username,'--out',out,'--accounts-db',this.env.X_ACCOUNTS_DB||'/app/x-accounts/accounts.db','--progress',progress,'--end',job.end,...(job.start?['--start',job.start]:[])];
    if(this.historyRunner)return this.historyRunner(job,{out,progress,args});
    await this.child(args,{allowedCodes:[0,1,2]});
    const result=load(progress,null);
    if(!result || !['complete','partial','needs_start','failed'].includes(result.status))throw Error('X_HISTORY_RESULT_MISSING');
    return result;
  }
  child(args,{capture=false,allowedCodes=[0],track=true}={}) {
    return new Promise((resolve,reject)=>{
      const child=spawn('python3',args,{stdio:['ignore',capture?'pipe':'ignore','ignore']});
      const field=track?'childProcess':'poolProcess';
      this[field]=child;let output='';
      if(capture)child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk;else child.kill('SIGTERM');});
      child.on('error',()=>reject(Error('X_PYTHON_UNAVAILABLE')));
      child.on('close',code=>{if(this[field]===child)this[field]=null;allowedCodes.includes(code)?resolve(output):reject(Error('X_HISTORY_PROCESS_FAILED'));});
    });
  }
  historyAllowed(job) {
    const ids=this.subscriptions(job.username).map(s=>s.userId);
    return ids.length>0 && (job.gap || job.userIds.some(id=>ids.includes(id)));
  }
  cancelRevokedHistories() {
    for(const job of Object.values(this.state.history))if(['working','importing'].includes(job.status)&&!this.historyAllowed(job)) {
      job.cancelRequested=true;this.childProcess?.kill('SIGTERM');
    }
  }
  startNextHistory(now) {
    if(this.historyTask||this.stopping||this.env.X_HISTORY_ENABLED!=='1')return;
    const job=Object.values(this.state.history).sort((a,b)=>a.at-b.at).find(j=>['queued','retry'].includes(j.status)&&now>=(j.retryAt||0));
    if(!job)return;
    if(job.cancelRequested||!this.historyAllowed(job)) {job.status='cancelled';this.persist();this.writeJob(job);return;}
    if(this.state.pool.active>0&&this.state.pool.available===0&&this.state.pool.nextAvailableAt>now) {
      job.status='retry';job.reason='X_NO_ACCOUNT_AVAILABLE';job.retryAt=this.state.pool.nextAvailableAt+1000;
      this.persist();this.writeJob(job);return;
    }
    job.status='working';job.attempts++;this.persist();this.writeJob(job);
    if((!job.gap||job.requestIds.length)&&!job.startedNotified) {
      this.notice(`X @${job.username} 歷史回補已開始，可從帳號選單查看進度。`,job.username,`${job.id}:started`,job.userIds,{noticeKey:`history:${job.id}`,noticeKind:'progress'});
      job.startedNotified=true;
    }
    this.historyTask=(async()=>{
      try {
        const result=await this.runHistory(job);
        if(job.cancelRequested||!this.historyAllowed(job))throw Error('X_HISTORY_CANCELLED');
        if(result.status==='needs_start') {
          job.status='needs_start';job.reason='X_START_DATE_REQUIRED';job.fetchDone=true;return;
        }
        if(result.status==='failed')throw Error(/^X_[A-Z0-9_]+$/.test(result.reason||'')?result.reason:'X_HISTORY_FAILED');
        job.status='importing';this.persist();this.writeJob(job);
        const file=path.join(this.historyDirectory(job.username),`${job.username}_posts.jsonl`);
        const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw Error('X_UNSAFE_PATH');
        job.posts=await this.importHistory(job.username,this.historyRecords(file),Date.now(),()=>!job.cancelRequested&&this.historyAllowed(job),job);
        job.status=['complete','partial','needs_start','failed'].includes(result.status)?result.status:'partial';
        job.start=result.start || job.start;
        job.reason=result.reason;
        job.fetchDone=true;
        // Completion is sent only after the shared media queue has drained.
      } catch(error) {
        if(job.cancelRequested||error.message==='X_HISTORY_CANCELLED') {job.status='cancelled';return;}
        if(this.stopping) {job.status='queued';job.attempts--;job.retryAt=0;return;}
        job.reason=safeReason(error);
        // Rate locks/session refresh are waiting states, not exhausted scraping attempts.
        if(job.reason==='X_NO_ACCOUNT_AVAILABLE') {job.attempts--;job.status='retry';}
        else job.status=job.attempts<(recoverable(job.reason)?6:3)?'retry':'failed';
        job.retryAt=Date.now()+Math.min(3600000,300000*2**Math.max(0,job.attempts-1));
        if(job.status==='failed')this.notice(`X @${job.username} 歷史回補失敗：${job.reason}`,job.username,`${job.id}:error:${job.attempts}`,job.userIds,{noticeKey:`history:${job.id}`,noticeKind:'progress'});
      } finally {this.persist();this.writeJob(job);this.historyTask=null;}
    })();
  }
  async renderHistory(job) {
    const out=this.historyDirectory(job.username),media={};
    const posts=path.join(out,'posts');
    const byPath=new Map();
    if(fs.existsSync(posts))for(const filename of fs.readdirSync(posts).filter(n=>/^[1-9]\d{0,24}\.json$/.test(n))) {
      const file=path.join(posts,filename);if(fs.lstatSync(file).isSymbolicLink())throw Error('X_UNSAFE_PATH');
      const record=load(file,null);
      for(const item of record?.event?.media || []) {
        const local=record.result?.files?.find(f=>path.basename(f.relativePath).startsWith(`${item.sourceId}_${String(item.index).padStart(2,'0')}.`));
        if(!local)continue;
        const entry={path:path.join(this.root,local.relativePath),kind:item.mediaType===2?'video':'image',error:null};
        media[item.url]=entry;
        try {const u=new URL(item.url);byPath.set(u.hostname+u.pathname,entry);}catch{/* Invalid source URLs never reach downloads. */}
      }
    }
    const jsonl=path.join(out,`${job.username}_posts.jsonl`);
    if(!fs.existsSync(jsonl))return;
    // Existing extractor keys original URLs; name=orig is only a transfer choice.
    const aliases=value=>{
      if(typeof value==='string') {
        try {const u=new URL(value),entry=byPath.get(u.hostname+u.pathname);if(entry)media[value]=entry;}catch{/* Non-URL post text. */}
      } else if(Array.isArray(value))for(const child of value)aliases(child);
      else if(value&&typeof value==='object')for(const child of Object.values(value))aliases(child);
    };
    for await(const record of this.historyRecords(jsonl))aliases(record.media),aliases(record.quoted_tweet),aliases(record.retweeted_tweet);
    atomic(path.join(out,'media_manifest.json'),{media,generated_at:new Date().toISOString()});
    await this.child([pythonScript('extract_x_archive.py'),out,'--render-only']);
  }
  async finishHistories() {
    if(this.historyTask)return;
    for(const job of Object.values(this.state.history)) {
      if(!job.fetchDone||job.reported)continue;
      const account=this.account(job.username);
      const pending=job.archiveKeysReady&&Array.isArray(job.archiveKeys)
        ?job.archiveKeys.some(key=>!account.seen[key]||account.pending[key]):Object.keys(account.pending).length>0;
      if(pending)continue;
      if(['complete','partial'].includes(job.status)&&this.env.X_HISTORY_ENABLED==='1') {
        job.phase='rendering';job.archiveUpdatedAt=Date.now();this.writeJob(job);
        try {await this.renderHistory(job);}
        catch(error) {job.reason=safeReason(error);job.status='partial';}
      }
      const labels={complete:'搜尋流程已完成',partial:'部分完成，仍有未完成區段',needs_start:'無法取得建立日期，請用 /xhistory 指定起日',failed:'失敗'};
      if(!job.gap||job.requestIds.length||job.status!=='complete')this.notice(`X @${job.username} 歷史回補：${labels[job.status]||job.status}；已匯入 ${job.posts||0} 篇並封存可取得的媒體。搜尋完成不代表歷史完整無缺。`,job.username,`${job.id}:result`,job.userIds,{noticeKey:`history:${job.id}`,noticeKind:'progress'});
      job.reported=true;delete job.phase;this.persist();this.writeJob(job);
    }
  }
  health(now=Date.now()) {
    const running=Object.values(this.state.history).find(j=>['working','importing'].includes(j.status));
    for(const job of Object.values(this.state.history)) if(active(job.status)||job.fetchDone&&!job.reported)this.writeJob(job,now);
    const data={at:now,enabled:true,phase:this.stopping?'stopped':'running',pool:this.state.pool,
      targets:this.names().map(username=>{const a=this.account(username);return {username,failures:a.failures,reason:a.reason,pending:Object.keys(a.pending).length,saved:Object.keys(a.seen).length-Object.keys(a.pending).length,lastSuccess:a.lastSuccess};}),
      history:running?{username:running.username,status:running.status}:null,
      historyJobs:Object.values(this.state.history).sort((a,b)=>Number(active(b.status)||!!(b.fetchDone&&!b.reported))-Number(active(a.status)||!!(a.fetchDone&&!a.reported))||b.at-a.at).slice(0,50).map(job=>this.historyReport(job,now))};
    atomic(path.join(this.dir,'health.json'),data);return data;
  }
  async refreshPool(now) {
    if(this.stopping||this.env.X_HISTORY_ENABLED!=='1'||now<(this.state.poolNextAt||0))return;
    try {
      // Status reads use a separate handle so cancellation still targets the history job.
      const output=await this.child([pythonScript('x_history_worker.py'),'status','--accounts-db',this.env.X_ACCOUNTS_DB||'/app/x-accounts/accounts.db'],{capture:true,track:false});
      const pool=JSON.parse(output);
      if(!Number.isInteger(pool.active)||!Number.isInteger(pool.locked)||pool.locked<0||pool.locked>pool.active)throw Error('X_POOL_INVALID');
      const nextAvailableAt=Number.isFinite(pool.nextAvailableAt)&&pool.nextAvailableAt>now?pool.nextAvailableAt:null;
      this.state.pool={active:pool.active,locked:pool.locked,available:pool.active-pool.locked,nextAvailableAt,checkedAt:now};
      this.state.poolFailures=0;
      this.state.poolEmptyChecks=pool.active?0:(this.state.poolEmptyChecks||0)+1;
      for(const job of Object.values(this.state.history)) {
        if(job.status!=='retry'||job.reason!=='X_NO_ACCOUNT_AVAILABLE')continue;
        if(this.state.pool.available>0)job.retryAt=now;
        else if(nextAvailableAt)job.retryAt=nextAvailableAt+1000;
        this.writeJob(job,now);
      }
      if(!pool.active&&this.state.poolEmptyChecks>=3&&!this.state.poolWarned){this.notice('X 歷史回補沒有可用登入帳號，請管理員在主機端更新 twscrape 帳號池。',null,'pool-empty:'+now,undefined,{noticeKey:'pool',noticeKind:'error'});this.state.poolWarned=true;}
      if(pool.active&&this.state.poolWarned){this.notice('X 歷史回補帳號池已恢復可用。',null,'pool-recovery:'+now,undefined,{noticeKey:'pool',noticeKind:'recovery'});this.state.poolWarned=false;}
    } catch(error) {
      if(this.stopping)return;
      this.state.pool={active:0,locked:0,reason:safeReason(error)};
      this.state.poolEmptyChecks=0;this.state.poolFailures=(this.state.poolFailures||0)+1;
      if(this.state.poolFailures>=3&&!this.state.poolWarned){this.notice('X 帳號池狀態讀取失敗，請管理員檢查 accounts.db。',null,'pool-failed:'+now,undefined,{noticeKey:'pool',noticeKind:'error'});this.state.poolWarned=true;}
    }
    this.state.poolNextAt=now+30000;this.persist();
  }
  async cycle(now=Date.now()) {
    this.cancelRevokedHistories();
    this.syncRequests(now);
    await this.hydrateArchiveProgress();
    await this.manualRequests(now);
    for(const name of this.names())await this.pollAccount(name,now);
    await this.archivePending(now);
    await this.finishHistories();
    await this.refreshPool(now);
    this.startNextHistory(now);
    this.health();
  }
  async stop() {
    this.stopping=true;this.childProcess?.kill('SIGTERM');this.poolProcess?.kill('SIGTERM');
    if(this.historyTask)await this.historyTask;
    this.health();
  }
}

export async function run({env=process.env,args=process.argv}={}) {
  const stateDir=env.IG_STATE_DIR||'/app/state',root=env.IG_ARCHIVE_DIR||'/downloads';
  if(env.X_ENABLED==='0'||env.IG_TELEGRAM_CONTROL==='0') {
    const health=()=>atomic(path.join(stateDir,'x/health.json'),{at:Date.now(),enabled:false,phase:'disabled',targets:[]});
    health();if(args.includes('--once'))return;
    await new Promise(resolve=>{const tick=setInterval(health,15000);const stop=()=>{clearInterval(tick);for(const s of ['SIGTERM','SIGINT'])process.off(s,stop);resolve();};for(const s of ['SIGTERM','SIGINT'])process.on(s,stop);});
    return;
  }
  const watcher=new XWatcher({stateDir,root,env,settings:()=>readSettings(settingsFile(env))});
  log('X_WATCH_STARTED',{intervalSeconds:watcher.interval/1000,historyEnabled:env.X_HISTORY_ENABLED==='1'});
  let stopping=false;
  const stop=()=>{stopping=true;watcher.stopping=true;watcher.childProcess?.kill('SIGTERM');watcher.poolProcess?.kill('SIGTERM');};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  const heartbeat=setInterval(()=>{try{watcher.health();}catch{stop();}},15000);
  try {
    do {await watcher.cycle();if(!args.includes('--once')&&!stopping)await new Promise(r=>setTimeout(r,watcher.workInterval));}while(!stopping&&!args.includes('--once'));
  } finally {clearInterval(heartbeat);await watcher.stop();for(const signal of ['SIGINT','SIGTERM'])process.off(signal,stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(error=>{log('X_WATCH_FATAL',{reason:safeReason(error)});process.exitCode=1;});

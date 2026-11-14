import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveBatch } from '../src/archive-batch.mjs';

test('archive batches cap dispatch at 50 and three concurrent tasks', async () => {
  let active=0,peak=0,done=0;
  await archiveBatch(Array.from({length:60}),async()=>{
    active++;peak=Math.max(peak,active);await Promise.resolve();active--;done++;
  });
  assert.equal(done,50);assert.equal(peak,3);assert.equal(active,0);
});
test('deadline stops new dispatch and drains started tasks', async t => {
  let clock=0,done=0;
  t.mock.method(performance,'now',()=>clock);
  await archiveBatch(Array.from({length:60}),async()=>{await Promise.resolve();clock=15001;done++;});
  assert.equal(done,3);
});
test('fatal errors propagate only after other in-flight tasks settle', async () => {
  let drained=false;
  await assert.rejects(archiveBatch([1,2],async id=>{
    if(id===1)throw Error('STATE_FAILURE');
    await new Promise(resolve=>setImmediate(resolve));drained=true;
  }),/STATE_FAILURE/);
  assert.equal(drained,true);
});

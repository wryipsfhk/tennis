import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('browser uses private account APIs and no collection endpoint',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(source,/\/acepoint-cloud\/player/);
  assert.match(source,/\/acepoint-cloud\/session/);
  assert.match(source,/Authorization:`Bearer/);
  assert.doesNotMatch(source,/\/api\/accounts/);
  assert.match(source,/XMLHttpRequest/);
  assert.match(source,/safariLoginFallback/);
  assert.doesNotMatch(source,/setError\('#loginError',error\.message\|\|'Load failed'/);
});

test('analysis remains local first, then syncs private chunks',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const localSave=source.indexOf('saveAnalysisVideo(result.id');
  const cloudUpload=source.indexOf('uploadAnalysisVideo(result');
  assert.ok(localSave>=0&&cloudUpload>localSave);
  assert.match(source,/\/chunk`/);
  assert.match(source,/cloudVideo=true/);
  assert.match(source,/Sync video now/);
  assert.match(source,/Video synced across devices/);
});

test('movement analysis uses distinct short windows and understandable failures',async()=>{
  const analyzer=await readFile(new URL('../client-analyzer.js',import.meta.url),'utf8');
  const worker=await readFile(new URL('../pose-worker.js',import.meta.url),'utf8');
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(worker,/runningMode: "IMAGE"/);
  assert.match(analyzer,/movementWindowCenters\(candidate,source\.duration\)/);
  assert.match(analyzer,/distinctWindows\.size<2/);
  assert.match(analyzer,/analysisVersion:9/);
  assert.match(app,/We lost track of the selected player/);
  assert.match(app,/No report or advice was created/);
});

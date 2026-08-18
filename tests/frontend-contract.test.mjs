import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('browser uses private account APIs and no collection endpoint',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  assert.match(source,/\/api\/account/);
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

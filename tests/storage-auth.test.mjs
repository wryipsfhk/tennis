import test from 'node:test';
import assert from 'node:assert/strict';
import {accountKey,createSession,createVideoTicket,decodeSession,decodeVideoTicket,normalizeAccount,ownsAnalysis,parseRange,publicAccount,videoPrefix} from '../netlify/functions/_lib.mjs';

const SECRET='test-only-secret-that-is-long-enough';
const account=normalizeAccount({name:'A',email:'a@example.com',passwordHash:'f'.repeat(64),analyses:[{id:'analysis_12345'}]},'a@example.com');

test('session tokens are signed, expire, and identify one account',()=>{
  const token=createSession(account,100,SECRET);
  const claims=decodeSession(token,101,SECRET);
  assert.equal(claims.sub,accountKey('a@example.com'));
  assert.throws(()=>decodeSession(token+'x',101,SECRET),/Invalid session/);
  assert.throws(()=>decodeSession(token,100+31*86400,SECRET),/expired/i);
});

test('video tickets are short lived and scoped to one analysis',()=>{
  const ticket=createVideoTicket(account,'analysis_12345',100,SECRET);
  assert.equal(decodeVideoTicket(ticket,'analysis_12345',101,SECRET).sub,account.id);
  assert.throws(()=>decodeVideoTicket(ticket,'another_analysis',101,SECRET),/expired/i);
  assert.throws(()=>decodeVideoTicket(ticket,'analysis_12345',701,SECRET),/expired/i);
});

test('public account responses never expose authentication fields',()=>{
  const safe=publicAccount(account);
  assert.equal(safe.email,'a@example.com');
  assert.equal('passwordHash' in safe,false);
  assert.equal('sessionVersion' in safe,false);
  assert.equal('id' in safe,false);
});

test('video object keys and ownership remain account scoped',()=>{
  const other=normalizeAccount({email:'b@example.com',analyses:[]},'b@example.com');
  assert.notEqual(videoPrefix(account.id,'analysis_12345'),videoPrefix(other.id,'analysis_12345'));
  assert.equal(ownsAnalysis(account,'analysis_12345'),true);
  assert.equal(ownsAnalysis(other,'analysis_12345'),false);
  assert.throws(()=>videoPrefix(account.id,'../../outside'),/Invalid/);
});

test('range streaming caps every response to one upload chunk',()=>{
  assert.deepEqual(parseRange('bytes=100-999',10000,256),{start:100,end:355,partial:true});
  assert.deepEqual(parseRange('bytes=-100',10000,256),{start:9900,end:9999,partial:true});
  assert.throws(()=>parseRange('items=1-2',10000),/Invalid/);
});

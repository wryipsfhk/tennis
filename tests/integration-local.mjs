import assert from 'node:assert/strict';

const base=process.env.ACEPOINT_TEST_URL||'http://127.0.0.1:4189';
const suffix=Date.now(),passwordHash='a'.repeat(64),analysisId=`analysis_${suffix}`;
async function api(path,options={}){const response=await fetch(base+path,options),body=await response.json().catch(()=>({}));return{response,body};}
async function signup(name,email){const {response,body}=await api('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'signup',name,email,passwordHash})});assert.equal(response.status,201,JSON.stringify(body));return body;}

const aliceEmail=`alice-${suffix}@example.com`,alice=await signup('Alice',aliceEmail),auth={Authorization:`Bearer ${alice.token}`};
alice.account.analyses=[{id:analysisId,name:'Cross-device test',cloudVideo:false}];
let result=await api('/api/account',{method:'PUT',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(alice.account)});assert.equal(result.response.status,200,JSON.stringify(result.body));
const source=new TextEncoder().encode('private-video-test-content');
result=await api(`/api/videos/${analysisId}/chunk`,{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream','X-Chunk-Index':'0','X-Total-Chunks':'1','X-File-Size':String(source.length),'X-Video-Type':'video/mp4'},body:source});assert.equal(result.response.status,200,JSON.stringify(result.body));
result=await api(`/api/videos/${analysisId}/complete`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({totalChunks:1,fileSize:source.length,contentType:'video/mp4',fileName:'private.mp4'})});assert.equal(result.response.status,201,JSON.stringify(result.body));

const secondSession=await api('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',email:aliceEmail,passwordHash})});assert.equal(secondSession.response.status,200);assert.equal(secondSession.body.account.analyses[0].id,analysisId);
const secondAuth={Authorization:`Bearer ${secondSession.body.token}`};result=await api(`/api/videos/${analysisId}/ticket`,{method:'POST',headers:secondAuth});assert.equal(result.response.status,200);const playback=await fetch(base+result.body.videoUrl,{headers:{Range:'bytes=0-'}});assert.equal(playback.status,206);assert.deepEqual(new Uint8Array(await playback.arrayBuffer()),source);

const bob=await signup('Bob',`bob-${suffix}@example.com`);result=await api(`/api/videos/${analysisId}/ticket`,{method:'POST',headers:{Authorization:`Bearer ${bob.token}`}});assert.equal(result.response.status,404);result=await api(`/api/videos/${analysisId}`,{method:'DELETE',headers:{Authorization:`Bearer ${bob.token}`}});assert.equal(result.response.status,404);
console.log('Local integration passed: second-session playback works and another account is denied.');

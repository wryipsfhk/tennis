export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
export const MAX_VIDEO_DURATION = 45 * 60;

const DB_NAME = "acepoint-analysis-videos";
const DB_VERSION = 1;
const STORE_NAME = "videos";
const CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[28,30],[29,31],[30,32]];
let worker;
let requestId = 0;
const requests = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAnalysisVideo(id, file) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(file, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadAnalysisVideo(id) {
  const db = await openDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function deleteAnalysisVideo(id) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function ensureWorker() {
  if (!worker) {
    worker = new Worker(new URL("./pose-worker.js", import.meta.url));
    worker.addEventListener("message", event => {
      const pending = requests.get(event.data.id);
      if (!pending) return;
      requests.delete(event.data.id);
      event.data.ok ? pending.resolve(event.data) : pending.reject(new Error(event.data.error));
    });
    worker.addEventListener("error", event => {
      for (const pending of requests.values()) pending.reject(new Error(event.message || "The pose worker stopped."));
      requests.clear();
      worker = null;
    });
  }
  return worker;
}

function workerRequest(type, data = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    requests.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, type, ...data }, transfer);
  });
}

export function clientAnalysisSupport() {
  return {
    supported: Boolean(window.Worker && window.WebAssembly && window.createImageBitmap && window.indexedDB),
    worker: Boolean(window.Worker), wasm: Boolean(window.WebAssembly), indexedDB: Boolean(window.indexedDB)
  };
}

export async function initializePoseModel() { await workerRequest("init"); }

function waitFor(target, event, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Video ${event} timed out.`)); }, timeout);
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(event, done); target.removeEventListener("error", failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("This browser could not decode the video.")); };
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

export async function createVideoSource(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await waitFor(video, "loadedmetadata");
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("The video duration could not be read.");
  if (video.duration > MAX_VIDEO_DURATION) throw new Error("Video must be 45 minutes or shorter for in-browser analysis.");
  if (!video.videoWidth || !video.videoHeight) throw new Error("No readable video frames were found.");
  return { video, url, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
}

async function seek(video, time) {
  const safeTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.03));
  if (Math.abs(video.currentTime - safeTime) < 0.025 && video.readyState >= 2) return;
  const waiting = waitFor(video, "seeked");
  video.currentTime = safeTime;
  await waiting;
}

async function detectFrame(video, time) {
  await seek(video, time);
  const width = Math.min(640, video.videoWidth);
  const height = Math.round(width * video.videoHeight / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, width, height);
  const bitmap = await createImageBitmap(canvas);
  return workerRequest("detect", { bitmap }, [bitmap]);
}

function visible(point) { return point && Number(point.visibility ?? 1) >= 0.22; }
function midpoint(a, b) { return { x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:((a.z||0)+(b.z||0))/2 }; }
function distance(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function median(values) { const sorted=[...values].sort((a,b)=>a-b); return sorted.length ? sorted[Math.floor(sorted.length/2)] : 0; }
function percentile(values, fraction) { const sorted=[...values].sort((a,b)=>a-b); return sorted.length ? sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction))] : 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function poseObservation(landmarks, worldLandmarks, time, poseIndex) {
  const points = landmarks.filter(visible);
  if (points.length < 10) return null;
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  const bbox={x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
  if (bbox.height < 0.08) return null;
  const hips=visible(landmarks[23])&&visible(landmarks[24])?midpoint(landmarks[23],landmarks[24]):null;
  return {time,poseIndex,landmarks,worldLandmarks,bbox,center:hips||{x:bbox.x+bbox.width/2,y:bbox.y+bbox.height/2},scale:bbox.height,visibility:Math.round(points.reduce((sum,p)=>sum+(p.visibility??1),0)/points.length*100)};
}

function evenlySpaced(duration, count, edge = 0.025) {
  if (count === 1) return [duration/2];
  const start=duration*edge, end=duration*(1-edge);
  return Array.from({length:count},(_,index)=>start+(end-start)*index/(count-1));
}

function clusterPlayers(observations) {
  const tracks=[];
  observations.sort((a,b)=>a.time-b.time).forEach(observation => {
    let best=null, bestScore=Infinity;
    for (const track of tracks) {
      const gap=observation.time-track.lastTime;
      if (gap<=.001 || gap>Math.max(90,track.sampleGap*4)) continue;
      const spatial=distance(observation.center,track.center)/Math.max(.16,(observation.scale+track.scale)/2);
      const scaleShift=Math.abs(Math.log(Math.max(.05,observation.scale)/Math.max(.05,track.scale)));
      const score=spatial+scaleShift*.35;
      if(score<1.65&&score<bestScore){best=track;bestScore=score;}
    }
    if(!best){best={items:[],center:{...observation.center},scale:observation.scale,lastTime:observation.time,sampleGap:5};tracks.push(best);}
    if(best.items.length)best.sampleGap=Math.max(.1,observation.time-best.lastTime);
    best.items.push(observation);best.center={x:best.center.x*.65+observation.center.x*.35,y:best.center.y*.65+observation.center.y*.35};best.scale=best.scale*.65+observation.scale*.35;best.lastTime=observation.time;
  });
  return tracks.filter(track=>track.items.length>=2).sort((a,b)=>median(b.items.map(i=>i.center.y))-median(a.items.map(i=>i.center.y))).slice(0,4);
}

async function thumbnail(video, observation) {
  await seek(video, observation.time);
  const source=observation.bbox, pad=.09;
  const x=clamp(source.x-pad,0,1), y=clamp(source.y-pad,0,1), right=clamp(source.x+source.width+pad,0,1), bottom=clamp(source.y+source.height+pad,0,1);
  const canvas=document.createElement("canvas");canvas.width=260;canvas.height=170;
  const ctx=canvas.getContext("2d");ctx.fillStyle="#173d36";ctx.fillRect(0,0,canvas.width,canvas.height);
  const sx=x*video.videoWidth,sy=y*video.videoHeight,sw=(right-x)*video.videoWidth,sh=(bottom-y)*video.videoHeight;
  const ratio=Math.min(canvas.width/sw,canvas.height/sh),dw=sw*ratio,dh=sh*ratio;
  ctx.drawImage(video,sx,sy,sw,sh,(canvas.width-dw)/2,(canvas.height-dh)/2,dw,dh);
  return canvas.toDataURL("image/jpeg",.76);
}

export async function preparePlayers(source, onProgress = () => {}) {
  onProgress(4,"Loading the browser pose model");
  await initializePoseModel();
  const count=clamp(Math.ceil(source.duration/8),10,18), times=evenlySpaced(source.duration,count);
  const observations=[];
  for(let i=0;i<times.length;i++){
    const result=await detectFrame(source.video,times[i]);
    (result.landmarks||[]).forEach((points,index)=>{const item=poseObservation(points,result.worldLandmarks?.[index]||[],times[i],index);if(item)observations.push(item);});
    onProgress(12+Math.round((i+1)/times.length*68),`Finding players · ${i+1} of ${times.length} sampled frames`);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  const tracks=clusterPlayers(observations);
  if(!tracks.length)throw new Error(`No player pose stayed visible across enough sampled frames (${observations.length} clear pose detections). Try a clearer fixed-camera video.`);
  const candidates=[];
  for(let index=0;index<tracks.length;index++){
    const track=tracks[index],best=[...track.items].sort((a,b)=>b.visibility-a.visibility)[0];
    candidates.push({label:tracks.length===1?"Selected player":index===0?"Near-side player":index===1?"Far-side player":`Player ${index+1}`,bbox:best.bbox,anchor:{x:median(track.items.map(i=>i.center.x)),y:median(track.items.map(i=>i.center.y)),scale:median(track.items.map(i=>i.scale))},detectionFrames:track.items.length,bestTime:best.time,thumbnail:await thumbnail(source.video,best)});
  }
  onProgress(100,`${candidates.length} player ${candidates.length===1?"track":"tracks"} found`);
  return candidates;
}

function angle(a,b,c){if(!visible(a)||!visible(b)||!visible(c))return null;const ab={x:a.x-b.x,y:a.y-b.y},cb={x:c.x-b.x,y:c.y-b.y};const denominator=Math.hypot(ab.x,ab.y)*Math.hypot(cb.x,cb.y);if(!denominator)return null;return Math.acos(clamp((ab.x*cb.x+ab.y*cb.y)/denominator,-1,1))*180/Math.PI;}
function average(values){const clean=values.filter(Number.isFinite);return clean.length?clean.reduce((a,b)=>a+b,0)/clean.length:null;}

function metrics(record, previous) {
  const p=record.landmarks,w=record.worldLandmarks||[];
  const shoulders=visible(p[11])&&visible(p[12])?distance(p[11],p[12]):null;
  const ankles=visible(p[27])&&visible(p[28])?distance(p[27],p[28]):null;
  const hip=visible(p[23])&&visible(p[24])?midpoint(p[23],p[24]):null,shoulder=visible(p[11])&&visible(p[12])?midpoint(p[11],p[12]):null,ankle=visible(p[27])&&visible(p[28])?midpoint(p[27],p[28]):null;
  let energy=null;
  if(previous){const ids=[11,12,15,16,23,24,27,28].filter(id=>visible(p[id])&&visible(previous.landmarks[id]));const dt=Math.max(.12,record.time-previous.time);energy=ids.length>=5?average(ids.map(id=>distance(p[id],previous.landmarks[id])))/Math.max(.08,shoulders||record.scale*.25)/dt:null;}
  let turnDepth=null;
  if(w[11]&&w[12]){const breadth=Math.hypot(w[11].x-w[12].x,w[11].y-w[12].y,w[11].z-w[12].z);if(breadth>.02)turnDepth=Math.abs(w[11].z-w[12].z)/breadth;}
  const stanceRatio=shoulders&&ankles?ankles/shoulders:null;
  return {kneeAngle:average([angle(p[23],p[25],p[27]),angle(p[24],p[26],p[28])]),elbowAngle:average([angle(p[11],p[13],p[15]),angle(p[12],p[14],p[16])]),stanceRatio,balanceOffset:hip&&ankle&&ankles&&stanceRatio>.45?Math.abs(hip.x-ankle.x)/(ankles/2):null,torsoLean:hip&&shoulder?Math.abs(Math.atan2(shoulder.x-hip.x,hip.y-shoulder.y))*180/Math.PI:null,turnDepth,motionEnergy:energy};
}

function closestPose(result,time,candidate,last) {
  const observations=(result.landmarks||[]).map((points,index)=>poseObservation(points,result.worldLandmarks?.[index]||[],time,index)).filter(Boolean);
  let best=null,bestScore=Infinity;
  for(const item of observations){const anchor=last||candidate.anchor;const spatial=distance(item.center,anchor)/Math.max(.16,(item.scale+(anchor.scale||item.scale))/2),origin=distance(item.center,candidate.anchor)/Math.max(.16,(item.scale+candidate.anchor.scale)/2);const scaleShift=Math.abs(Math.log(Math.max(.05,item.scale)/Math.max(.05,anchor.scale||item.scale)));const score=spatial+origin*.1+scaleShift*.3;if(score<bestScore){best=item;bestScore=score;}}
  return bestScore<=1.3?{item:best,score:bestScore}:null;
}

const ISSUE_DEFINITIONS=[
  {key:"balance",label:"Body center moved beyond the support base",test:m=>m.balanceOffset!=null&&m.balanceOffset>1.05,severity:m=>m.balanceOffset,measured:m=>`Body-center offset measured ${m.balanceOffset.toFixed(2)}× half the foot-base width.`,feedback:(m,t)=>`At ${t.toFixed(2)} sec, the hip midpoint moved outside the base formed by both ankles. Keep the chest between the feet through the swing, then recover with the outside leg before changing direction.`,goal:"Keep the body center inside the support base during moving strokes",drill:"Shadow swings with split-step and balanced recovery · 3 × 12"},
  {key:"stance",label:"Support base narrowed during active movement",test:m=>m.stanceRatio!=null&&m.stanceRatio<.82&&m.motionEnergy>.08,severity:m=>1-m.stanceRatio,measured:m=>`Ankle spacing was ${m.stanceRatio.toFixed(2)}× shoulder width.`,feedback:(m,t)=>`At ${t.toFixed(2)} sec, both feet came closer than shoulder width while the upper body was moving. Re-establish a split step before the opponent strikes and keep enough width to push in either direction.`,goal:"Build a repeatable split-step and wider support base",drill:"Split-step to first-ball movement · 3 × 10 each direction"},
  {key:"knees",label:"Leg loading stayed shallow in a high-movement window",test:m=>m.kneeAngle!=null&&m.kneeAngle>165&&m.motionEnergy>.12,severity:m=>m.kneeAngle,measured:m=>`Average visible knee angle was ${Math.round(m.kneeAngle)}° during active movement.`,feedback:(m,t)=>`At ${t.toFixed(2)} sec, the visible knees stayed almost straight while the body was moving quickly. Lower the hips before the directional push so the legs can absorb and redirect force.`,goal:"Use clearer leg loading before fast direction changes",drill:"Wide-base load and recover shadow drill · 3 × 10"},
  {key:"lean",label:"Torso moved far outside a stacked position",test:m=>m.torsoLean!=null&&m.torsoLean>27&&m.motionEnergy>.07,severity:m=>m.torsoLean,measured:m=>`Torso lean measured ${Math.round(m.torsoLean)}° from vertical.`,feedback:(m,t)=>`At ${t.toFixed(2)} sec, the shoulder midpoint shifted ${Math.round(m.torsoLean)}° away from vertical over the hips. Create more distance with the feet first, then swing with the chest more stable over the base.`,goal:"Maintain a more stable torso while moving to the ball",drill:"Move-set-hit-recover shadow sequence · 3 × 8 each side"},
  {key:"arm",label:"Hitting arm remained tightly folded through a fast window",test:m=>m.elbowAngle!=null&&m.elbowAngle<102&&m.motionEnergy>.13,severity:m=>180-m.elbowAngle,measured:m=>`Average visible elbow angle was ${Math.round(m.elbowAngle)}°.`,feedback:(m,t)=>`At ${t.toFixed(2)} sec, the visible hitting-arm shape stayed compressed while the wrists were moving quickly. Give the swing more space by setting the feet earlier and extending away from the torso through the forward path.`,goal:"Create more swing space between the body and hitting arm",drill:"Drop-feed spacing drill · 3 × 15 each side"}
];

function selectFindings(records) {
  const energies=records.map(r=>r.metrics.motionEnergy).filter(Number.isFinite),activeCutoff=Math.max(.07,percentile(energies,.55));
  records.forEach(r=>{if(r.metrics.motionEnergy!=null&&r.metrics.motionEnergy<activeCutoff)r.metrics.motionEnergy*=.75;});
  const findings=[];
  for(const definition of ISSUE_DEFINITIONS){const matches=records.filter(r=>definition.test(r.metrics)).sort((a,b)=>definition.severity(b.metrics)-definition.severity(a.metrics));if(matches.length<2)continue;const chosen=matches.find(record=>findings.every(item=>Math.abs(item.record.time-record.time)>1.4));if(chosen)findings.push({definition,record:chosen,repeatCount:matches.length});if(findings.length===3)break;}
  return findings;
}

async function evidenceFrame(video, record, definition) {
  await seek(video,record.time);const width=Math.min(900,video.videoWidth),height=Math.round(width*video.videoHeight/video.videoWidth),canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");ctx.drawImage(video,0,0,width,height);
  ctx.lineWidth=Math.max(2,width/300);ctx.strokeStyle="#d8ef72";ctx.fillStyle="#d8ef72";ctx.globalAlpha=.92;
  for(const [a,b] of CONNECTIONS){const p=record.landmarks[a],q=record.landmarks[b];if(!visible(p)||!visible(q))continue;ctx.beginPath();ctx.moveTo(p.x*width,p.y*height);ctx.lineTo(q.x*width,q.y*height);ctx.stroke();}
  record.landmarks.forEach((p,index)=>{if(index<11||!visible(p))return;ctx.beginPath();ctx.arc(p.x*width,p.y*height,Math.max(2,width/260),0,Math.PI*2);ctx.fill();});
  ctx.globalAlpha=1;ctx.fillStyle="rgba(18,52,44,.88)";ctx.fillRect(14,14,Math.min(width-28,520),42);ctx.fillStyle="#fff";ctx.font=`600 ${Math.max(14,width/48)}px system-ui`;ctx.fillText(`${record.time.toFixed(2)} sec · ${definition.label}`,27,42,Math.min(width-55,490));
  return canvas.toDataURL("image/jpeg",.76);
}

export async function analyzePlayer(source,candidate,onProgress=()=>{}) {
  const sampleCount=clamp(Math.ceil(source.duration/4),24,54),times=evenlySpaced(source.duration,sampleCount,.015),records=[];let last=null,totalIdentity=0;
  for(let i=0;i<times.length;i++){
    const result=await detectFrame(source.video,times[i]),match=closestPose(result,times[i],candidate,last);
    if(match){const record=match.item;record.metrics=metrics(record,records.at(-1));records.push(record);last={...record.center,scale:record.scale};totalIdentity+=Math.max(0,1-match.score/1.05);}
    onProgress(5+Math.round((i+1)/times.length*76),`Reviewing movement · ${i+1} of ${times.length} sampled frames`);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(records.length<Math.max(6,sampleCount*.22))throw new Error("The selected player could not be followed consistently enough to create a report.");
  const findings=selectFindings(records),checks=[],frames=[],interval=source.duration/Math.max(1,sampleCount-1);
  for(let i=0;i<findings.length;i++){
    const {definition,record,repeatCount}=findings[i],confidence=Math.round(clamp((record.visibility*.55)+(Math.min(1,repeatCount/4)*25)+(records.length/sampleCount*20),35,94));
    const check={status:"warn",label:definition.label,measured:definition.measured(record.metrics),feedback:definition.feedback(record.metrics,record.time),confidence,windowId:`W${i+1}`};checks.push(check);
    onProgress(83+Math.round((i+1)/Math.max(1,findings.length)*11),`Capturing evidence · ${i+1} of ${findings.length}`);
    frames.push({time:record.time,start:Math.max(0,record.time-Math.max(.9,interval*.72)),end:Math.min(source.duration,record.time+Math.max(1.1,interval*.72)),confidence,windowId:`W${i+1}`,label:definition.label,checkLabel:definition.label,url:await evidenceFrame(source.video,record,definition),mistake:true});
  }
  const visibility=Math.round(average(records.map(r=>r.visibility))||0),continuity=Math.round(records.length/sampleCount*100),identityConsistency=Math.round(totalIdentity/records.length*100),movementConfidence=Math.round(clamp(visibility*.45+continuity*.35+identityConsistency*.2,0,96));
  const stableBalance=records.filter(r=>r.metrics.balanceOffset!=null).filter(r=>r.metrics.balanceOffset<=.8).length;
  if(stableBalance>=Math.max(5,records.length*.55))checks.push({status:"good",label:"Support-base control",measured:`Centered in ${stableBalance} sampled poses`,feedback:"Your hip midpoint remained inside the visible foot base through most tracked movement windows."});
  if(!findings.length)checks.push({status:"unknown",label:"Reportable repeated issues",measured:"No movement pattern crossed the repeat-and-visibility threshold",feedback:"The analyzer does not create a fault from a single unclear frame."});
  const uniqueGoals=[...new Set(findings.map(item=>item.definition.goal))],uniqueDrills=[...new Set(findings.map(item=>item.definition.drill))];
  const id=crypto.randomUUID();onProgress(98,"Saving the movement report");
  return {id,analysisVersion:8,analysisMode:"browser-pose-multi-window-v1",model:"MediaPipe Pose Landmarker Lite",name:`Analysis · ${new Intl.DateTimeFormat("en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date())}`,movementName:"Full-match movement review",createdAt:new Date().toISOString(),selectedPlayer:candidate.label,playerBBox:candidate.bbox,coverage:continuity,movementConfidence,tracking:{continuity,averageVisibility:visibility,identityConsistency},movementMetrics:{sampledFrames:sampleCount,trackedFrames:records.length,reviewedWindows:frames.length},checks,frames,events:frames.map(frame=>({time:frame.time,start:frame.start,end:frame.end,label:frame.label,confidence:frame.confidence,windowId:frame.windowId})),overall:findings.length?`${findings.length} repeated movement ${findings.length===1?"pattern":"patterns"} to review`:"No repeated movement issue met the reporting threshold",goal:uniqueGoals[0]||"Keep reviewing movement quality across future matches",exercises:uniqueDrills,videoStorage:"indexeddb",sourceFileName:source.file?.name||"Match video",sourceFileSize:source.file?.size||0,duration:source.duration};
}

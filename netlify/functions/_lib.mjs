import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const ACCOUNT_STORE = "acepoint-accounts-v2";
export const VIDEO_STORE = "acepoint-private-videos-v1";
export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const SESSION_SECONDS = 60 * 60 * 24 * 30;

export function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {status, headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extraHeaders}});
}

export function accountKey(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
}

function secret() {
  const value=(process.env.ACEPOINT_SESSION_SECRET||process.env.JSONBIN_ACCESS_KEY||process.env.JSONBIN_MASTER_KEY||"").trim();
  if(value.length<24)throw new Error("ACEPOINT_SESSION_SECRET must be configured with at least 24 characters.");
  return value;
}

export function createSession(account, now=Math.floor(Date.now()/1000), signingSecret=secret()) {
  const payload=Buffer.from(JSON.stringify({sub:account.id,email:account.email,sv:account.sessionVersion||1,iat:now,exp:now+SESSION_SECONDS})).toString("base64url");
  const signature=createHmac("sha256",signingSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function decodeSession(token, now=Math.floor(Date.now()/1000), signingSecret=secret()) {
  if(!token||!token.includes("."))throw new Error("Authentication required.");
  const [payload,provided]=token.split(".");
  const expected=createHmac("sha256",signingSecret).update(payload).digest();
  let actual;try{actual=Buffer.from(provided,"base64url");}catch{throw new Error("Invalid session.");}
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error("Invalid session.");
  let claims;try{claims=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));}catch{throw new Error("Invalid session.");}
  if(!claims.sub||!claims.email||Number(claims.exp)<=now)throw new Error("Session expired.");
  return claims;
}

export function createVideoTicket(account,analysisId,now=Math.floor(Date.now()/1000),signingSecret=secret()) {
  const payload=Buffer.from(JSON.stringify({sub:account.id,aid:String(analysisId),purpose:"video",exp:now+600})).toString("base64url");
  const signature=createHmac("sha256",signingSecret).update(`video.${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function decodeVideoTicket(token,analysisId,now=Math.floor(Date.now()/1000),signingSecret=secret()) {
  if(!token||!token.includes("."))throw new Error("Video authorization required.");
  const [payload,provided]=token.split("."),expected=createHmac("sha256",signingSecret).update(`video.${payload}`).digest();
  let actual;try{actual=Buffer.from(provided,"base64url");}catch{throw new Error("Invalid video authorization.");}
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error("Invalid video authorization.");
  let claims;try{claims=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));}catch{throw new Error("Invalid video authorization.");}
  if(claims.purpose!=="video"||claims.aid!==String(analysisId)||!claims.sub||Number(claims.exp)<=now)throw new Error("Video authorization expired.");
  return claims;
}

export function bearer(request) {
  const value=request.headers.get("authorization")||"";
  return value.startsWith("Bearer ")?value.slice(7).trim():"";
}

export function normalizeAccount(source, emailOverride="") {
  const email=String(emailOverride||source?.email||"").trim().toLowerCase();
  return {schemaVersion:2,id:accountKey(email),name:String(source?.name||"Player").slice(0,100),email,passwordHash:String(source?.passwordHash||""),sessionVersion:Number(source?.sessionVersion)||1,matches:Array.isArray(source?.matches)?source.matches:[],goals:Array.isArray(source?.goals)?source.goals:[],scheduledMatches:Array.isArray(source?.scheduledMatches)?source.scheduledMatches:[],exercises:Array.isArray(source?.exercises)?source.exercises:[],analyses:Array.isArray(source?.analyses)?source.analyses:[],createdAt:source?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
}

export function publicAccount(account) {
  const {passwordHash,id,sessionVersion,...safe}=account;
  return safe;
}

export function accountStore() { return getStore(ACCOUNT_STORE); }
export function videoStore() { return getStore(VIDEO_STORE); }

export async function readAccountByKey(key) { return accountStore().get(key,{type:"json",consistency:"strong"}); }
export async function writeAccount(account) { await accountStore().setJSON(account.id,account); }

function jsonBinConfiguration() {
  const binId=(process.env.JSONBIN_BIN_ID||"").trim(),accessKey=(process.env.JSONBIN_ACCESS_KEY||"").trim(),masterKey=(process.env.JSONBIN_MASTER_KEY||"").trim();
  return {binId,accessKey,masterKey,configured:Boolean(binId&&(accessKey||masterKey))};
}

export async function migrateLegacyAccount(email) {
  const config=jsonBinConfiguration();if(!config.configured)return null;
  const headers={"X-Bin-Meta":"false","User-Agent":"AcePoint-Netlify/2.0"};headers[config.accessKey?"X-Access-Key":"X-Master-Key"]=config.accessKey||config.masterKey;
  const response=await fetch(`https://api.jsonbin.io/v3/b/${config.binId}/latest?meta=false`,{headers});if(!response.ok)return null;
  const result=await response.json().catch(()=>({})),accounts=result.record??result,legacy=accounts?.[email];if(!legacy)return null;
  const account=normalizeAccount(legacy,email);await writeAccount(account);return account;
}

export async function findAccount(email) {
  const key=accountKey(email);return await readAccountByKey(key)||await migrateLegacyAccount(String(email).trim().toLowerCase());
}

export async function authorize(request) {
  const claims=decodeSession(bearer(request)),account=await readAccountByKey(claims.sub);
  if(!account||account.email!==claims.email||Number(account.sessionVersion||1)!==Number(claims.sv))throw new Error("Session expired.");
  return account;
}

export function videoPrefix(accountId,analysisId) {
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(String(analysisId)))throw new Error("Invalid analysis identifier.");
  return `${accountId}/${analysisId}`;
}

export function chunkKey(accountId,analysisId,index) { return `${videoPrefix(accountId,analysisId)}/chunks/${String(index).padStart(4,"0")}`; }
export function manifestKey(accountId,analysisId) { return `${videoPrefix(accountId,analysisId)}/manifest`; }

export function ownsAnalysis(account,analysisId) { return (account.analyses||[]).some(item=>String(item.id)===String(analysisId)); }

export function parseRange(header,total,maxBytes=CHUNK_BYTES) {
  if(!header)return {start:0,end:Math.min(total-1,maxBytes-1),partial:total>maxBytes};
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());if(!match)throw new Error("Invalid range.");
  let start=match[1]?Number(match[1]):null,end=match[2]?Number(match[2]):null;
  if(start===null){const suffix=Math.min(Number(end)||0,total);start=total-suffix;end=total-1;}else{end=end===null?total-1:Math.min(end,total-1);}
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>end||start>=total)throw new Error("Invalid range.");
  end=Math.min(end,start+maxBytes-1);return {start,end,partial:true};
}

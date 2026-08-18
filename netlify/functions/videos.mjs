import {authorize,CHUNK_BYTES,chunkKey,createVideoTicket,decodeVideoTicket,json,manifestKey,MAX_VIDEO_BYTES,ownsAnalysis,parseRange,readAccountByKey,videoStore} from "./_lib.mjs";

const allowedTypes=new Set(["video/mp4","video/quicktime","video/webm","video/x-m4v","application/octet-stream"]);

export default async (request,context)=>{
  try{
    const analysisId=String(context.params?.id||""),action=String(context.params?.action||"");
    let account;
    if(request.method==="GET"&&!action){const ticket=new URL(request.url).searchParams.get("ticket");if(ticket){const claims=decodeVideoTicket(ticket,analysisId);account=await readAccountByKey(claims.sub);if(!account)throw new Error("Video authorization expired.");}else account=await authorize(request);}else account=await authorize(request);
    if(!ownsAnalysis(account,analysisId))return json(404,{error:"Video analysis not found."});
    const store=videoStore();
    if(request.method==="POST"&&action==="ticket")return json(200,{videoUrl:`/acepoint-cloud/video/${encodeURIComponent(analysisId)}?ticket=${encodeURIComponent(createVideoTicket(account,analysisId))}`,expiresIn:600});
    if(request.method==="POST"&&action==="chunk"){
      const index=Number(request.headers.get("x-chunk-index")),totalChunks=Number(request.headers.get("x-total-chunks")),fileSize=Number(request.headers.get("x-file-size")),contentType=(request.headers.get("x-video-type")||"application/octet-stream").split(";")[0];
      if(!Number.isInteger(index)||index<0||!Number.isInteger(totalChunks)||totalChunks<1||totalChunks>Math.ceil(MAX_VIDEO_BYTES/CHUNK_BYTES)||fileSize<1||fileSize>MAX_VIDEO_BYTES||!allowedTypes.has(contentType))return json(400,{error:"Invalid video chunk metadata."});
      const blob=await request.blob();if(blob.size<1||blob.size>CHUNK_BYTES)return json(413,{error:"Each video chunk must be 4 MB or smaller."});
      await store.set(chunkKey(account.id,analysisId,index),blob,{metadata:{owner:account.id,analysisId,index,totalChunks,fileSize,contentType}});
      return json(200,{uploaded:index+1,totalChunks});
    }
    if(request.method==="POST"&&action==="complete"){
      const body=await request.json(),totalChunks=Number(body.totalChunks),fileSize=Number(body.fileSize),contentType=String(body.contentType||"application/octet-stream"),fileName=String(body.fileName||"match-video").slice(0,180);
      if(!Number.isInteger(totalChunks)||totalChunks<1||totalChunks>Math.ceil(MAX_VIDEO_BYTES/CHUNK_BYTES)||fileSize<1||fileSize>MAX_VIDEO_BYTES||!allowedTypes.has(contentType))return json(400,{error:"Invalid video manifest."});
      for(let index=0;index<totalChunks;index++){if(!await store.getMetadata(chunkKey(account.id,analysisId,index)))return json(409,{error:`Video chunk ${index+1} is missing.`});}
      await store.setJSON(manifestKey(account.id,analysisId),{schemaVersion:1,owner:account.id,analysisId,totalChunks,fileSize,contentType,fileName,chunkBytes:CHUNK_BYTES,createdAt:new Date().toISOString()},{metadata:{owner:account.id,analysisId}});
      return json(201,{saved:true,videoUrl:`/acepoint-cloud/video/${analysisId}`});
    }
    if(request.method==="GET"&&!action){
      const manifest=await store.get(manifestKey(account.id,analysisId),{type:"json",consistency:"strong"});if(!manifest)return json(404,{error:"The source video has not been synced."});
      let range;try{range=parseRange(request.headers.get("range"),manifest.fileSize);}catch{return new Response(null,{status:416,headers:{"Content-Range":`bytes */${manifest.fileSize}`}});}
      const first=Math.floor(range.start/manifest.chunkBytes),last=Math.floor(range.end/manifest.chunkBytes),buffers=[];
      for(let index=first;index<=last;index++){const value=await store.get(chunkKey(account.id,analysisId,index),{type:"arrayBuffer",consistency:"strong"});if(!value)return json(404,{error:"A video chunk is missing."});buffers.push(new Uint8Array(value));}
      const combined=new Uint8Array(buffers.reduce((sum,item)=>sum+item.length,0));let offset=0;for(const item of buffers){combined.set(item,offset);offset+=item.length;}
      const base=first*manifest.chunkBytes,start=range.start-base,end=range.end-base+1,body=combined.slice(start,end);
      return new Response(body,{status:range.partial?206:200,headers:{"Content-Type":manifest.contentType,"Content-Length":String(body.length),"Accept-Ranges":"bytes","Content-Range":`bytes ${range.start}-${range.end}/${manifest.fileSize}`,"Cache-Control":"private, no-store","Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(manifest.fileName)}`}});
    }
    if(request.method==="DELETE"&&!action){
      const manifest=await store.get(manifestKey(account.id,analysisId),{type:"json",consistency:"strong"});if(manifest){await Promise.all(Array.from({length:manifest.totalChunks},(_,index)=>store.delete(chunkKey(account.id,analysisId,index))));await store.delete(manifestKey(account.id,analysisId));}
      return json(200,{deleted:true});
    }
    return json(405,{error:"This request method is not supported."});
  }catch(error){return json(/Authentication|Session|authorization/i.test(error.message)?401:400,{error:error.message||"Video request failed."});}
};

export const config={path:["/api/videos/:id","/api/videos/:id/:action","/acepoint-cloud/video/:id","/acepoint-cloud/video/:id/:action"]};

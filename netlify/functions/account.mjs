import {authorize,json,normalizeAccount,publicAccount,writeAccount} from "./_lib.mjs";

export default async request=>{
  try{
    const stored=await authorize(request);
    if(request.method==="GET")return json(200,{account:publicAccount(stored),storage:"netlify-blobs"});
    if(request.method==="PUT"){
      const raw=await request.text();if(new TextEncoder().encode(raw).length>4*1024*1024)return json(413,{error:"Account report data is too large."});
      const incoming=JSON.parse(raw),next=normalizeAccount({...incoming,email:stored.email,passwordHash:stored.passwordHash,id:stored.id,sessionVersion:stored.sessionVersion,createdAt:stored.createdAt},stored.email);await writeAccount(next);
      return json(200,{saved:true,account:publicAccount(next),storage:"netlify-blobs"});
    }
    return json(405,{error:"This request method is not supported."});
  }catch(error){return json(/Authentication|Session/.test(error.message)?401:400,{error:error.message||"Account request failed."});}
};

export const config={path:"/api/account"};

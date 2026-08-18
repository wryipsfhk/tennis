import {accountKey,createSession,findAccount,json,normalizeAccount,publicAccount,writeAccount} from "./_lib.mjs";

export default async request=>{
  if(request.method!=="POST")return json(405,{error:"This request method is not supported."});
  try{
    const body=await request.json(),action=String(body.action||"login"),email=String(body.email||"").trim().toLowerCase(),passwordHash=String(body.passwordHash||"");
    if(!/^\S+@\S+\.\S+$/.test(email)||passwordHash.length!==64)return json(400,{error:"Enter a valid email and password."});
    if(action==="signup"){
      if(await findAccount(email))return json(409,{error:"An account already exists for this email. Please sign in."});
      const account=normalizeAccount({id:accountKey(email),name:String(body.name||"").trim(),email,passwordHash,matches:[],goals:[],scheduledMatches:[],exercises:[],analyses:[],createdAt:new Date().toISOString()},email);await writeAccount(account);
      return json(201,{token:createSession(account),account:publicAccount(account),storage:"netlify-blobs"});
    }
    const account=await findAccount(email);
    if(!account)return json(401,{error:action==="reset"?"No account was found for this email.":"Incorrect email or password. Create an account first if you are new."});
    if(action==="reset"){account.passwordHash=passwordHash;account.sessionVersion=(account.sessionVersion||1)+1;await writeAccount(account);return json(200,{updated:true});}
    if(account.passwordHash!==passwordHash)return json(401,{error:"Incorrect email or password. Create an account first if you are new."});
    return json(200,{token:createSession(account),account:publicAccount(account),storage:"netlify-blobs"});
  }catch(error){return json(500,{error:error.message||"Authentication could not be completed."});}
};

export const config={path:["/api/auth","/acepoint-cloud/session"]};

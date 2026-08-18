export default async () => new Response(JSON.stringify({configured:true,connected:true,backend:"netlify-blobs",message:"Private account and video sync available"}),{status:200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});

export const config = {path: "/api/storage-status"};

export default async () => {
  const binId = (process.env.JSONBIN_BIN_ID || "").trim();
  const accessKey = (process.env.JSONBIN_ACCESS_KEY || "").trim();
  const masterKey = (process.env.JSONBIN_MASTER_KEY || "").trim();
  const configured = Boolean(binId && (accessKey || masterKey));
  const headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"};

  if (!configured) {
    return new Response(JSON.stringify({configured: false, connected: false, backend: "none", message: "JSONBin 尚未配置"}), {status: 200, headers});
  }

  try {
    const auth = accessKey ? {"X-Access-Key": accessKey} : {"X-Master-Key": masterKey};
    const remote = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest?meta=false`, {
      headers: {...auth, "X-Bin-Meta": "false", "User-Agent": "TennisProgress-Netlify/1.0"},
    });
    if (!remote.ok) throw new Error(`JSONBin ${remote.status}`);
    return new Response(JSON.stringify({configured: true, connected: true, backend: "jsonbin", message: "已连接 JSONBin"}), {status: 200, headers});
  } catch (error) {
    return new Response(JSON.stringify({configured: true, connected: false, backend: "jsonbin", message: error.message}), {status: 200, headers});
  }
};

export const config = {path: "/api/storage-status"};

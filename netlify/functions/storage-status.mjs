export default async () => {
  const binId = (process.env.JSONBIN_BIN_ID || "").trim();
  const explicitAccessKey = (process.env.JSONBIN_ACCESS_KEY || "").trim();
  const configuredMasterKey = (process.env.JSONBIN_MASTER_KEY || "").trim();
  const inferredAccessKey = !explicitAccessKey && configuredMasterKey && !configuredMasterKey.startsWith("$2") ? configuredMasterKey : "";
  const accessKey = explicitAccessKey || inferredAccessKey;
  const masterKey = accessKey ? "" : configuredMasterKey;
  const configured = Boolean(binId && (accessKey || masterKey));
  const headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"};

  if (!configured) {
    const missing = [!binId ? "JSONBIN_BIN_ID" : "", !accessKey && !masterKey ? "JSONBIN_MASTER_KEY" : ""].filter(Boolean);
    return new Response(JSON.stringify({configured: false, connected: false, backend: "none", message: `Missing: ${missing.join(", ")}`, missing}), {status: 200, headers});
  }

  try {
    const auth = accessKey ? {"X-Access-Key": accessKey} : {"X-Master-Key": masterKey};
    const remote = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest?meta=false`, {
      headers: {...auth, "X-Bin-Meta": "false", "User-Agent": "AcePoint-Netlify/1.0"},
    });
    if (!remote.ok) throw new Error(`JSONBin ${remote.status}`);
    return new Response(JSON.stringify({configured: true, connected: true, backend: "jsonbin", message: "Connected to JSONBin"}), {status: 200, headers});
  } catch (error) {
    return new Response(JSON.stringify({configured: true, connected: false, backend: "jsonbin", message: error.message}), {status: 200, headers});
  }
};

export const config = {path: "/api/storage-status"};

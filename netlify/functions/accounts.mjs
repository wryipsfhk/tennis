const JSONBIN_BASE_URL = "https://api.jsonbin.io/v3/b";

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function configuration() {
  const binId = (process.env.JSONBIN_BIN_ID || "").trim();
  const explicitAccessKey = (process.env.JSONBIN_ACCESS_KEY || "").trim();
  const configuredMasterKey = (process.env.JSONBIN_MASTER_KEY || "").trim();
  const inferredAccessKey = !explicitAccessKey && configuredMasterKey && !configuredMasterKey.startsWith("$2") ? configuredMasterKey : "";
  const accessKey = explicitAccessKey || inferredAccessKey;
  const masterKey = accessKey ? "" : configuredMasterKey;
  return {binId, accessKey, masterKey, configured: Boolean(binId && (accessKey || masterKey))};
}

function jsonBinHeaders(config, write = false) {
  const headers = {
    "X-Bin-Meta": "false",
    "User-Agent": "AcePoint-Netlify/1.0",
  };
  headers[config.accessKey ? "X-Access-Key" : "X-Master-Key"] = config.accessKey || config.masterKey;
  if (write) {
    headers["Content-Type"] = "application/json";
    headers["X-Bin-Versioning"] = "false";
  }
  return headers;
}

export default async (request) => {
  const config = configuration();
  if (!config.configured) {
    const missing = [
      !config.binId ? "JSONBIN_BIN_ID" : "",
      !config.accessKey && !config.masterKey ? "JSONBIN_MASTER_KEY" : "",
    ].filter(Boolean);
    return response(503, {error: `Netlify is missing environment variables: ${missing.join(", ")}`, missing});
  }

  try {
    if (request.method === "GET") {
      const remote = await fetch(`${JSONBIN_BASE_URL}/${config.binId}/latest?meta=false`, {
        headers: jsonBinHeaders(config),
      });
      const result = await remote.json().catch(() => ({}));
      if (!remote.ok) throw new Error(result.message || `JSONBin ${remote.status}`);
      return response(200, result.record ?? result);
    }

    if (request.method === "PUT") {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > 95 * 1024) {
        return response(413, {error: "The account data is approaching the JSONBin free-bin size limit."});
      }
      const accounts = JSON.parse(raw);
      if (!accounts || Array.isArray(accounts) || typeof accounts !== "object") {
        return response(400, {error: "Account data must be an object."});
      }
      const remote = await fetch(`${JSONBIN_BASE_URL}/${config.binId}`, {
        method: "PUT",
        headers: jsonBinHeaders(config, true),
        body: JSON.stringify(accounts),
      });
      const result = await remote.json().catch(() => ({}));
      if (!remote.ok) throw new Error(result.message || `JSONBin ${remote.status}`);
      return response(200, {saved: true, storage: "jsonbin"});
    }

    return response(405, {error: "This request method is not supported."});
  } catch (error) {
    return response(502, {error: `JSONBin sync failed: ${error.message || "Unknown error"}`});
  }
};

export const config = {path: "/api/accounts"};

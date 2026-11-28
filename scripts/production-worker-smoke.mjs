import { randomInt } from "node:crypto";

const MAX_DNS_MESSAGE_BYTES = 65535;

export function buildDnsProbeQuery(id = 0x3d7a, qname = "example.com") {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
    throw new Error("DNS transaction ID must be a 16-bit integer");
  }

  const labels = qname.toLowerCase().split(".");
  if (!labels.length || labels.some((label) => !label || label.length > 63)) {
    throw new Error("Invalid DNS probe name");
  }

  const qnameBytes = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "ascii");
    if (bytes.toString("ascii") !== label) throw new Error("DNS probe name must be ASCII");
    qnameBytes.push(Buffer.from([bytes.length]), bytes);
  }
  qnameBytes.push(Buffer.from([0]));

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1, QR=0, standard query
  header.writeUInt16BE(1, 4); // QDCOUNT
  const question = Buffer.concat([...qnameBytes, Buffer.from([0, 1, 0, 1])]); // A IN
  return Buffer.concat([header, question]);
}

export function verifyDnsProbeResponse(responseBytes, queryBytes) {
  const response = Buffer.from(responseBytes);
  const query = Buffer.from(queryBytes);

  if (response.byteLength < 12 || response.byteLength > MAX_DNS_MESSAGE_BYTES) {
    throw new Error("Production DoH returned an invalid DNS message length");
  }
  if (response.readUInt16BE(0) !== query.readUInt16BE(0)) {
    throw new Error("Production DoH response transaction ID mismatch");
  }

  const flags = response.readUInt16BE(2);
  if ((flags & 0x8000) === 0) throw new Error("Production DoH response is missing QR=1");
  if ((flags & 0x7800) !== 0) throw new Error("Production DoH response has an unexpected opcode");
  if ((flags & 0x0200) !== 0) throw new Error("Production DoH response is truncated");
  const rcode = flags & 0x000f;
  if (rcode !== 0) throw new Error(`Production DoH response returned DNS RCODE ${rcode}`);

  const questionCount = response.readUInt16BE(4);
  if (questionCount !== 1) throw new Error("Production DoH response did not echo exactly one question");
  const expectedQuestion = query.subarray(12);
  if (!response.subarray(12, 12 + expectedQuestion.length).equals(expectedQuestion)) {
    throw new Error("Production DoH response question does not match the probe");
  }

  const answerCount = response.readUInt16BE(6);
  if (answerCount < 1) throw new Error("Production DoH probe returned no A answers");

  return { rcode, questionCount, answerCount };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function runProductionWorkerSmoke(env = process.env) {
  const endpoint = new URL(requiredEnv("PRODUCTION_DOH_URL"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("PRODUCTION_DOH_URL must be an HTTPS URL without credentials, query string, or fragment");
  }
  const segments = endpoint.pathname.split("/").filter(Boolean);
  if (segments[0] !== "dns-query" || segments.length > 2) {
    throw new Error("PRODUCTION_DOH_URL must target /dns-query, optionally followed by its access-token segment");
  }

  const query = buildDnsProbeQuery(randomInt(0, 0x10000), "example.com");
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept": "application/dns-message",
      "content-type": "application/dns-message",
      "cache-control": "no-cache",
    },
    body: query,
    signal: AbortSignal.timeout(15000),
  });

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Production DoH endpoint returned HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/dns-message") {
    await response.body?.cancel().catch(() => {});
    throw new Error("Production DoH endpoint returned an unexpected content type");
  }

  const body = Buffer.from(await response.arrayBuffer());
  const dns = verifyDnsProbeResponse(body, query);

  return {
    status: "PASS",
    readOnly: true,
    method: "POST",
    route: "/dns-query",
    httpStatus: response.status,
    contentType,
    cfRayPresent: Boolean(response.headers.get("cf-ray")),
    ...dns,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

async function main() {
  const result = await runProductionWorkerSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      readOnly: true,
      error: error instanceof Error ? error.message : "Unknown production DNS probe error",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

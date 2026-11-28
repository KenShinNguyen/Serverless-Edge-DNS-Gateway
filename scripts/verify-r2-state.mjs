import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { validateEdnsV1Buffer } from "../src/rules-binary-format.ts";
import { assertManifestInvariants, LATEST_KEY } from "./r2-manifest.mjs";

function resolveRetentionLimit(raw = process.env.RETENTION_LIMIT) {
  if (raw === undefined || raw === "") return 5;
  const value = String(raw).trim();
  if (!/^[1-9]\\d*$/.test(value)) {
    throw new Error("Invalid RETENTION_LIMIT (must be a positive integer)");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("RETENTION_LIMIT must be between 1 and 50");
  }
  return parsed;
}

async function bodyString(body) {
  if (!body) return "";
  return body.transformToString();
}

async function getJson(s3, bucket, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await bodyString(response.Body));
}

async function getBytes(s3, bucket, key) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (response.Body?.transformToByteArray) return response.Body.transformToByteArray();
  throw new Error(`R2 object body cannot be read as bytes: ${key}`);
}

async function headRequired(s3, bucket, key) {
  const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!Number.isInteger(response.ContentLength) || response.ContentLength <= 0) {
    throw new Error(`R2 object is missing/empty: ${key}`);
  }
  return response;
}

export async function verifyAllHistoryStrict(s3, bucket, manifest, retentionLimit = 5) {
  assertManifestInvariants(manifest, retentionLimit);

  const verified = [];
  for (const [index, entry] of manifest.history.entries()) {
    const [binary, statsHead] = await Promise.all([
      getBytes(s3, bucket, entry.key),
      headRequired(s3, bucket, entry.stats),
    ]);

    if (binary.byteLength <= 0) {
      throw new Error(`R2 history[${index}] binary is empty: ${entry.key}`);
    }

    const validated = validateEdnsV1Buffer(binary);
    const actualSha = createHash("sha256").update(validated.bytes).digest("hex");

    if (actualSha !== entry.sha256) {
      throw new Error(`R2 history[${index}] SHA mismatch: expected ${entry.sha256}, got ${actualSha}`);
    }
    if (validated.count !== entry.rules) {
      throw new Error(`R2 history[${index}] rule count mismatch: manifest=${entry.rules}, binary=${validated.count}`);
    }

    verified.push({
      sha256: entry.sha256,
      binaryBytes: validated.bytes.byteLength,
      rules: validated.count,
      statsBytes: statsHead.ContentLength,
    });
  }

  const activeStats = await getJson(s3, bucket, manifest.stats);
  if (!activeStats || typeof activeStats !== "object") {
    throw new Error("Active stats.json is not a JSON object");
  }
  if (activeStats.sha256 !== manifest.sha256) {
    throw new Error(`Active stats sha256 mismatch: expected ${manifest.sha256}, got ${activeStats.sha256}`);
  }
  if (activeStats.rules !== manifest.rules) {
    throw new Error(`Active stats rules mismatch: expected ${manifest.rules}, got ${activeStats.rules}`);
  }

  return {
    status: "PASS",
    sha256: manifest.sha256,
    historyCount: manifest.history.length,
    revokedCount: manifest.revoked?.length ?? 0,
    verified,
  };
}

export async function verifyR2State(s3, bucket, retentionLimit = 5) {
  let manifest;
  try {
    manifest = await getJson(s3, bucket, LATEST_KEY);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") {
      throw new Error(`R2 state verification failed: ${LATEST_KEY} does not exist`);
    }
    throw error;
  }

  return verifyAllHistoryStrict(s3, bucket, manifest, retentionLimit);
}

async function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const bucket = process.env.R2_BUCKET_NAME || "dns-compiled-rules";
  const retentionLimit = resolveRetentionLimit();
  const endpoint = await requiredEnv("R2_ENDPOINT");
  const accessKeyId = await requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = await requiredEnv("R2_SECRET_ACCESS_KEY");

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const result = await verifyR2State(s3, bucket, retentionLimit);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  });
}

import { S3Client } from "@aws-sdk/client-s3";
import { verifyR2State } from "./verify-r2-state.mjs";

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(String(raw))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside the safe integer range`);
  return value;
}

export async function runReadOnlyR2Gate(env = process.env) {
  const endpoint = requiredEnv(env, "R2_READONLY_ENDPOINT");
  const accessKeyId = requiredEnv(env, "R2_READONLY_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv(env, "R2_READONLY_SECRET_ACCESS_KEY");
  const bucket = requiredEnv(env, "R2_BUCKET_NAME");
  const retentionLimit = positiveInteger(env, "R2_RETENTION_LIMIT", 5);
  const expectedShaPrefix = requiredEnv(env, "EXPECTED_R2_SHA256_PREFIX");
  const expectedRuleCount = positiveInteger(env, "EXPECTED_R2_RULE_COUNT", 366391);
  const expectedBinaryBytes = positiveInteger(env, "EXPECTED_R2_BINARY_BYTES", 8785954);

  if (!/^[0-9a-f]{8,64}$/.test(expectedShaPrefix)) {
    throw new Error("EXPECTED_R2_SHA256_PREFIX must be 8..64 lowercase hexadecimal characters");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const result = await verifyR2State(s3, bucket, retentionLimit);
  const active = result.verified[0];

  if (!result.sha256.startsWith(expectedShaPrefix)) {
    throw new Error("Active R2 SHA-256 does not match the frozen production baseline");
  }
  if (!active || active.rules !== expectedRuleCount) {
    throw new Error("Active R2 rule count does not match the frozen production baseline");
  }
  if (active.binaryBytes !== expectedBinaryBytes) {
    throw new Error("Active R2 binary size does not match the frozen production baseline");
  }

  return {
    status: "PASS",
    readOnly: true,
    bucket,
    operations: ["GetObject", "HeadObject"],
    active: {
      sha256: result.sha256,
      rules: active.rules,
      binaryBytes: active.binaryBytes,
    },
    historyCount: result.historyCount,
    revokedCount: result.revokedCount,
    verifiedHistory: result.verified,
  };
}

async function main() {
  const result = await runReadOnlyR2Gate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      readOnly: true,
      error: error instanceof Error ? error.message : "Unknown R2 verification error",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

import { readFile } from "node:fs/promises";

function assertInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

/**
 * Fail closed when a generated rule file falls below its minimum or drops
 * farther than the configured percentage from the last committed version.
 * A missing/empty previous file is treated as a first-run baseline.
 */
export function assertRuleUpdateSafe({
  previousCount,
  candidateCount,
  maxDropPercent,
  minCount,
  label = "rules",
}) {
  assertInteger(previousCount, "previousCount", 0, Number.MAX_SAFE_INTEGER);
  assertInteger(candidateCount, "candidateCount", 0, Number.MAX_SAFE_INTEGER);
  assertInteger(maxDropPercent, "maxDropPercent", 0, 100);
  assertInteger(minCount, "minCount", 0, Number.MAX_SAFE_INTEGER);

  if (candidateCount < minCount) {
    throw new Error(`${label} candidate has ${candidateCount} entries; minimum is ${minCount}`);
  }

  if (previousCount > 0) {
    const minimumAllowed = Math.ceil(previousCount * (100 - maxDropPercent) / 100);
    if (candidateCount < minimumAllowed) {
      throw new Error(
        `${label} drop guard failed: previous=${previousCount}, candidate=${candidateCount}, ` +
        `maximumDrop=${maxDropPercent}%, minimumAllowed=${minimumAllowed}`
      );
    }
  }

  return {
    label,
    previousCount,
    candidateCount,
    maxDropPercent,
    minimumAllowed: previousCount > 0
      ? Math.ceil(previousCount * (100 - maxDropPercent) / 100)
      : minCount,
    baseline: previousCount > 0 ? "previous-file" : "first-run",
  };
}

function countRules(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .length;
}

async function readPrevious(path) {
  try {
    return countRules(await readFile(path, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function main() {
  const [previousPath, candidatePath, maxDropRaw, minCountRaw, label = "rules"] = process.argv.slice(2);
  if (!previousPath || !candidatePath || maxDropRaw === undefined || minCountRaw === undefined) {
    throw new Error("usage: node scripts/check-rule-drop.mjs <previous-file> <candidate-file> <max-drop-percent> <min-count> <label>");
  }
  const maxDropPercent = Number(maxDropRaw);
  const minCount = Number(minCountRaw);
  const previousCount = await readPrevious(previousPath);
  const candidateCount = countRules(await readFile(candidatePath, "utf8"));
  const result = assertRuleUpdateSafe({ previousCount, candidateCount, maxDropPercent, minCount, label });
  process.stdout.write(`[PASS] ${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`[DROP GUARD] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import fs from "fs";
import path from "path";
import type { Challenge } from "./types";

const CHALLENGE_DIR = path.join(
  process.cwd(),
  "use-cases",
  "uc8-sof-verification",
  "data",
  "challenges"
);

function ensureDir() {
  if (!fs.existsSync(CHALLENGE_DIR)) {
    fs.mkdirSync(CHALLENGE_DIR, { recursive: true });
  }
}

function filePath(challengeId: string): string {
  if (!/^[a-f0-9]{8,64}$/i.test(challengeId)) {
    throw new Error("Invalid challenge id");
  }
  return path.join(CHALLENGE_DIR, `${challengeId}.json`);
}

export function saveChallenge(ch: Challenge): Challenge {
  ensureDir();
  fs.writeFileSync(filePath(ch.challengeId), JSON.stringify(ch, null, 2));
  return ch;
}

export function readChallenge(challengeId: string): Challenge | null {
  try {
    ensureDir();
    const p = filePath(challengeId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Challenge;
  } catch {
    return null;
  }
}

export function updateChallenge(ch: Challenge): Challenge {
  return saveChallenge(ch);
}

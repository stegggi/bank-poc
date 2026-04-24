import type { Challenge } from "./types";
import { readJson, writeJson } from "./blobStore";

const CHALLENGE_PREFIX = "challenges/";

function challengePath(challengeId: string): string {
  if (!/^[a-f0-9]{8,64}$/i.test(challengeId)) {
    throw new Error("Invalid challenge id");
  }
  return `${CHALLENGE_PREFIX}${challengeId}.json`;
}

export async function saveChallenge(ch: Challenge): Promise<Challenge> {
  await writeJson(challengePath(ch.challengeId), ch);
  return ch;
}

export async function readChallenge(challengeId: string): Promise<Challenge | null> {
  try {
    return await readJson<Challenge>(challengePath(challengeId));
  } catch {
    return null;
  }
}

export async function updateChallenge(ch: Challenge): Promise<Challenge> {
  return saveChallenge(ch);
}

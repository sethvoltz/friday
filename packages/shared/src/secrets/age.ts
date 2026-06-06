import { readFileSync } from "node:fs";
import * as age from "age-encryption";
import { AGE_KEY_PATH } from "./paths.js";

export async function generateAgeKeypair(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  return { identity, recipient };
}

export function readAgeIdentityFromDisk(): string | undefined {
  try {
    const raw = readFileSync(AGE_KEY_PATH, "utf8").trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export async function encryptPayload(plaintext: string, recipient: string): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(plaintext);
}

export async function decryptPayload(ciphertext: Uint8Array, identity: string): Promise<string> {
  const d = new age.Decrypter();
  d.addIdentity(identity);
  const out = await d.decrypt(ciphertext, "text");
  if (typeof out !== "string") {
    throw new Error("age decrypt returned non-text");
  }
  return out;
}

export async function identityToRecipient(identity: string): Promise<string> {
  return age.identityToRecipient(identity);
}

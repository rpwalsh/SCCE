import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";

export interface SecretEnvelope {
  version: 1;
  alg: "aes-256-gcm";
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export function encryptSecret(plain: string, keyMaterial: string): string {
  if (!keyMaterial) throw new Error("cannot encrypt secret without config security.localMasterKey");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(keyMaterial, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: SecretEnvelope = { version: 1, alg: "aes-256-gcm", salt: salt.toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: tag.toString("base64url") };
  return `enc:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")}`;
}

export function decryptSecret(value: string, keyMaterial: string): string {
  if (!value.startsWith("enc:v1:")) return value;
  if (!keyMaterial) throw new Error("encrypted secret requires config security.localMasterKey");
  const envelope = JSON.parse(Buffer.from(value.slice("enc:v1:".length), "base64url").toString("utf8")) as SecretEnvelope;
  if (envelope.version !== 1 || envelope.alg !== "aes-256-gcm") throw new Error("unsupported secret envelope");
  const salt = Buffer.from(envelope.salt, "base64url");
  const key = deriveKey(keyMaterial, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function resolveSecret(value: string | undefined, config: ScceRuntimeConfig, label: string): string {
  if (!value) throw new Error(`${label} is not configured in scce.config.json`);
  return decryptSecret(value, config.security?.localMasterKey ?? "");
}

export function redactSecretValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value) return value;
  if (value.startsWith("enc:v1:")) return "enc:v1:[REDACTED]";
  if (value.length <= 6) return "[REDACTED]";
  return `${value.slice(0, 2)}...[REDACTED]...${value.slice(-2)}`;
}

export function redactConfigSecrets(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSecretValue(value) as string;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(item => redactConfigSecrets(item));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /token|secret|password|key|sid|authorization/i.test(key) ? redactSecretValue(item) as JsonValue : redactConfigSecrets(item);
    }
    return out;
  }
  return String(value);
}

function deriveKey(keyMaterial: string, salt: Buffer): Buffer {
  return createHash("sha256").update("scce-v3-secret\0").update(keyMaterial).update("\0").update(salt).digest();
}

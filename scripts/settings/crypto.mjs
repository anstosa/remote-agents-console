import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from "node:crypto";
import { MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "./constants.mjs";
import { safeError } from "./fs.mjs";

// hash private source bytes for exact conflict checks
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// encode unambiguous authenticated fields
export function frameFields(fields) {
  const pieces = [Buffer.from([PROTOCOL_VERSION])];
  // prefix every field with its byte length
  for (const field of fields) {
    const bytes = Buffer.from(String(field), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    pieces.push(length, bytes);
  }
  return Buffer.concat(pieces);
}

// seal one source for the in-memory recipient
export function encryptReveal({ descriptor, request, sourceId, plaintext }) {
  if (plaintext.length > MAX_SOURCE_BYTES) {
    throw safeError("disclosure-failed");
  }
  try {
    const recipient = createPublicKey({
      key: Buffer.from(request.reveal.publicKey, "base64url"),
      format: "der",
      type: "spki"
    });
    if (recipient.asymmetricKeyType !== "x25519") {
      throw safeError("disclosure-failed");
    }
    const sender = generateKeyPairSync("x25519");
    const shared = diffieHellman({ privateKey: sender.privateKey, publicKey: recipient });
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const aad = Buffer.from(request.reveal.binding, "utf8");
    const info = Buffer.concat([
      Buffer.from("rac-settings-reveal/v1", "utf8"),
      createHash("sha256").update(aad).digest()
    ]);
    const key = Buffer.from(hkdfSync("sha256", shared, salt, info, 32));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    shared.fill(0);
    key.fill(0);
    return {
      version: PROTOCOL_VERSION,
      publicKey: sender.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      binding: request.reveal.binding,
      expiresAt: request.reveal.expiresAt
    };
  } catch {
    throw safeError("disclosure-failed");
  }
}

// parse a private test key without exposing it to the queue
export function importX25519PrivateKey(der) {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// seal private recovery state with the installation key
export function sealLocal(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    version: PROTOCOL_VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

// open private recovery state without serializing plaintext
export function openLocal(key, envelope) {
  try {
    if (envelope?.version !== PROTOCOL_VERSION) {
      throw new Error("version");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw safeError("recovery-unavailable");
  }
}

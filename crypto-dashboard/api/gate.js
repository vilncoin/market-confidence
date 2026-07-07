// Token gating for VILN holders.
// Verifies a Phantom wallet signature (proves ownership) and checks on-chain VILN balance.
// All checks run server-side so the gate can't be bypassed from the browser.

import nacl from "tweetnacl";

// ---- Config (easy to change) ----
export const VILN_MINT = "8TE24cDPjHHeh8BntbmFAiNFJR9kC7qjEdDArwyfpump";
export const MIN_VILN = 1000; // minimum tokens required to unlock analysis
// Solana RPC. Public endpoint works but is rate-limited; set SOLANA_RPC env to a
// Helius/QuickNode URL for reliability. Falls back to the public mainnet endpoint.
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

// base58 decode (no external dep) for verifying the pubkey/signature.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  let bytes = [0];
  for (const c of str) {
    const val = B58.indexOf(c);
    if (val < 0) throw new Error("bad base58");
    for (let i = 0; i < bytes.length; i++) bytes[i] *= 58;
    bytes[0] += val;
    let carry = 0;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] += carry;
      carry = bytes[i] >> 8;
      bytes[i] &= 0xff;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; str[k] === "1" && k < str.length - 1; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

// Verify the wallet actually signed our challenge message.
export function verifySignature(message, signatureB58, publicKeyB58) {
  try {
    const msg = new TextEncoder().encode(message);
    const sig = b58decode(signatureB58);
    const pub = b58decode(publicKeyB58);
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

// Query the wallet's VILN balance via Solana RPC.
export async function getVilnBalance(owner) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [owner, { mint: VILN_MINT }, { encoding: "jsonParsed" }],
  };
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("RPC error " + r.status);
  const data = await r.json();
  const accts = data?.result?.value || [];
  let total = 0;
  for (const a of accts) {
    const amt = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof amt === "number") total += amt;
  }
  return total;
}

// Full gate check: signature valid AND balance >= MIN_VILN.
export async function checkGate({ address, message, signature }) {
  if (!address || !message || !signature) {
    return { ok: false, reason: "missing_auth" };
  }
  if (!verifySignature(message, signature, address)) {
    return { ok: false, reason: "bad_signature" };
  }
  let balance;
  try {
    balance = await getVilnBalance(address);
  } catch (e) {
    return { ok: false, reason: "rpc_error", detail: String(e.message || e) };
  }
  if (balance < MIN_VILN) {
    return { ok: false, reason: "insufficient", balance };
  }
  return { ok: true, balance };
}

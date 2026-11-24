// Rotating student QR: signing and verification (no backend, no database).
//
// Problem: asking MetaMask to sign every 30 seconds would be unusable.
// Solution: the student signs ONCE per session with MetaMask to authorise a
// temporary key that only lives in this browser tab. That temporary key then
// signs a fresh timestamp every 30 seconds, so the QR keeps changing without
// any more MetaMask popups.
//
//   QR = { student, session, delegate, delegation (MetaMask sig), ts, sig (temp-key sig) }
//
// Faculty verifies both signatures and that the timestamp is fresh, then sends
// the on-chain markAttendance(sessionId, student) transaction.

import { Wallet, verifyMessage, getAddress } from "ethers";
import addressConfig from "./contract-address.json";

export const QR_REFRESH_MS = 30_000; // the student's QR changes this often
export const QR_MAX_AGE_S = 60;      // faculty rejects a QR older than this

function delegationText({ chainId, sessionId, student, delegate }) {
  return [
    "BlockAttend attendance key",
    `contract: ${addressConfig.address}`,
    `chain: ${chainId}`,
    `session: ${sessionId}`,
    `student: ${student}`,
    `temporary key: ${delegate}`
  ].join("\n");
}

function tickText({ sessionId, student, ts }) {
  return `BlockAttend QR|${sessionId}|${student}|${ts}`;
}

// One MetaMask signature per session.
export async function startStudentQrSession(signer, { chainId, sessionId }) {
  const student = await signer.getAddress();
  const temp = Wallet.createRandom();
  const delegation = await signer.signMessage(
    delegationText({ chainId, sessionId, student, delegate: temp.address })
  );
  return { temp, student, sessionId, chainId, delegation };
}

// Called every QR_REFRESH_MS. No wallet popup.
export async function makeStudentQr(session) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await session.temp.signMessage(
    tickText({ sessionId: session.sessionId, student: session.student, ts })
  );

  return JSON.stringify({
    type: "blockattend-student",
    session: session.sessionId,
    student: session.student,
    delegate: session.temp.address,
    delegation: session.delegation,
    ts,
    sig
  });
}

// Returns { student, sessionId } or throws an Error with a plain-language reason.
export function verifyStudentQr(text, { chainId, expectedSessionId }) {
  let q;

  try {
    q = JSON.parse(text);
  } catch {
    throw new Error("This is not a BlockAttend student QR.");
  }

  if (q.type !== "blockattend-student") {
    throw new Error("This is not a BlockAttend student QR.");
  }

  let student;
  let delegate;

  try {
    student = getAddress(q.student);
    delegate = getAddress(q.delegate);
  } catch {
    throw new Error("The QR contains an invalid wallet address.");
  }

  const sessionId = Number(q.session);

  if (expectedSessionId && sessionId !== Number(expectedSessionId)) {
    throw new Error(`This QR is for session #${sessionId}, not the open session #${expectedSessionId}.`);
  }

  const age = Math.floor(Date.now() / 1000) - Number(q.ts);

  if (!Number.isFinite(age) || age > QR_MAX_AGE_S || age < -QR_MAX_AGE_S) {
    throw new Error("This QR is out of date. Ask the student to show their live QR.");
  }

  let signer1;
  let signer2;

  try {
    signer1 = verifyMessage(
      delegationText({ chainId, sessionId, student, delegate }),
      q.delegation
    );
    signer2 = verifyMessage(tickText({ sessionId, student, ts: q.ts }), q.sig);
  } catch {
    throw new Error("The QR signature is not valid.");
  }

  if (signer1 !== student || signer2 !== delegate) {
    throw new Error("The QR signature does not match the student's wallet.");
  }

  return { student, sessionId };
}

// ----- CSV -----

export function toCsv(rows) {
  return rows
    .map(row => row.map(cell => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

export function downloadCsv(filename, rows) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" })
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

import hre from "hardhat";

const { ethers } = hre;

// ---------- tiny colour helpers ----------
const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const cyan = c(36), green = c(32), yellow = c(33), magenta = c(35), dim = c(2), bold = c(1), red = c(31);
const line = (ch = "─", n = 78) => ch.repeat(n);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DAY = 24 * 60 * 60;

// Sends one transaction, waits for its block and prints the important parts.
async function showBlock(label, tx, note = "") {
  const sent = await tx;
  const receipt = await sent.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);

  // txHash = keccak256(RLP-encoded signed transaction)
  const recomputed = ethers.keccak256(ethers.Transaction.from(sent).serialized);

  console.log(`\n${bold(magenta("▶ " + label))} ${dim(note)}`);
  console.log(`  from        : ${sent.from}`);
  console.log(`  tx hash     : ${yellow(sent.hash)}  ${recomputed === sent.hash ? green("✔ keccak256 matches") : red("✘ mismatch")}`);
  console.log(`  block       : ${green("#" + block.number)}  ${green(short(block.hash))}  ← parent ${dim(short(block.parentHash))}`);
  console.log(`  gas / status: ${receipt.gasUsed}  ${receipt.status === 1 ? green("success") : red("failed")}`);

  await sleep(250);
  return { receipt, block };
}

// Shows that the contract rejects an action it must not allow.
async function mustRevert(label, promise) {
  try {
    await (await promise).wait();
    console.log(`  ${red("✘ NOT rejected")}  ${label}`);
  } catch (e) {
    console.log(`  ${green("✔ rejected")}      ${label}  ${dim("(" + (e.shortMessage || e.message).split("\n")[0].slice(0, 70) + ")")}`);
  }
}

async function eligibilityLine(contract, student, title) {
  const s = await contract.getStudentStats(1, student.address);
  const sem = await contract.getSemesterSession(1);
  const state = sem.ended ? "semester ended" : "semester running";
  console.log(
    `  ${title.padEnd(22)} attended ${s.attended}/${s.total} (${s.percentage}%)  ` +
    `threshold ${s.threshold}%  ${dim(state)}  eligible: ${s.eligible ? green("YES") : red("NO")}`
  );
}

async function main() {
  const [admin, faculty, student, outsider] = await ethers.getSigners();

  console.log(bold("\n=== BlockAttend demo: admin, locked settings, semester eligibility ===\n"));
  console.log(`Network  : ${hre.network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Admin    : ${admin.address}`);
  console.log(`Faculty  : ${faculty.address}`);
  console.log(`Student  : ${student.address}`);
  console.log(`Outsider : ${outsider.address}  ${dim("(never authorized)")}`);

  // ---- Deploy ----
  const Factory = await ethers.getContractFactory("BlockAttend");
  const contract = await Factory.deploy();
  await showBlock("Deploy BlockAttend", contract.deploymentTransaction(), "contract creation");
  console.log(`  contract    : ${await contract.getAddress()}`);

  const onChainAdmin = await contract.institutionAdmin();
  console.log(
    `  institutionAdmin(): ${onChainAdmin}  ` +
    `${onChainAdmin === admin.address ? green("✔ is the admin wallet") : red("✘ differs from the first Hardhat account")}`
  );

  // ---- Admin authorizes wallets (its only job) ----
  await showBlock("Admin authorizes faculty", contract.authorizeFaculty(faculty.address), "authorizeFaculty()");
  await showBlock("Admin authorizes student", contract.authorizeStudent(student.address), "authorizeStudent()");

  // ---- Faculty course + semester session (both locked once set) ----
  await showBlock(
    "Faculty creates course",
    contract.connect(faculty).createCourse("Blockchain", "CS425", "Demo course", "Fall 2026", "Mon 10:00", 75),
    "createCourse(), threshold 75%"
  );
  const semEnd = (await ethers.provider.getBlock("latest")).timestamp + 30 * DAY;
  await showBlock(
    "Faculty sets semester session",
    contract.connect(faculty).setSemesterSession(1, semEnd),
    `setSemesterSession(), ends ${new Date(semEnd * 1000).toISOString().slice(0, 10)}`
  );

  // ---- Enrollment ----
  await showBlock("Student requests to join", contract.connect(student).requestEnrollment(1), "requestEnrollment()");
  await showBlock("Faculty approves student", contract.connect(faculty).approveStudent(1, student.address), "approveStudent()");
  await showBlock("Student enrolls", contract.connect(student).enroll(1), "enroll()");

  // ---- Attendance ----
  await showBlock("Faculty starts attendance session", contract.connect(faculty).startSession(1, 10), "startSession() (max 10 min)");
  await showBlock("Faculty scans student QR, marks attendance", contract.connect(faculty).markAttendance(1, student.address), "markAttendance()");

  console.log(`\n${bold("DUPLICATE ATTENDANCE")}`);
  await mustRevert("same student marked twice in one session", contract.connect(faculty).markAttendance(1, student.address));

  // ---- Eligibility depends on the semester session ----
  console.log(`\n${bold("ELIGIBILITY (decided only when the semester session ends)")}`);
  await eligibilityLine(contract, student, "During semester:");

  await ethers.provider.send("evm_increaseTime", [31 * DAY]);
  await ethers.provider.send("evm_mine", []);
  console.log(dim("  … time moved forward 31 days (local test chain only) …"));

  await eligibilityLine(contract, student, "After semester ends:");

  // ---- Rules the contract enforces ----
  console.log(`\n${bold("REJECTED ACTIONS (enforced by the contract)")}`);
  await mustRevert("non-admin authorizes a faculty wallet", contract.connect(outsider).authorizeFaculty(outsider.address));
  await mustRevert("non-admin authorizes a student wallet", contract.connect(outsider).authorizeStudent(outsider.address));
  await mustRevert("unauthorized wallet creates a course", contract.connect(outsider).createCourse("X", "X1", "", "", "", 75));
  await mustRevert("faculty sets a second semester session", contract.connect(faculty).setSemesterSession(1, semEnd + 60 * DAY));
  await mustRevert("faculty starts a session after the semester ended", contract.connect(faculty).startSession(1, 5));
  await mustRevert("student saves profile twice", (async () => {
    const first = await contract.connect(student).setStudentProfile("Demo Student", "MCA001");
    await first.wait();
    return contract.connect(student).setStudentProfile("Changed Name", "MCA002");
  })());

  // ---- Chain linkage ----
  const latest = await ethers.provider.getBlockNumber();
  let linked = true;
  for (let i = 1; i <= latest; i++) {
    const b = await ethers.provider.getBlock(i);
    if (b.parentHash !== (await ethers.provider.getBlock(i - 1)).hash) linked = false;
  }
  console.log(`\n${bold("CHAIN LINKAGE")}  ${latest + 1} blocks, each stores its parent's hash: ${linked ? green("✔ all linked") : red("✘ broken")}`);
  console.log(cyan(line()));
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
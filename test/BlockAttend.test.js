import { expect } from "chai";
import hre from "hardhat";
const { ethers } = hre;

const SEMESTER_SECONDS = 30 * 24 * 60 * 60;

async function semesterEnd() {
  const latest = await ethers.provider.getBlock("latest");
  return latest.timestamp + SEMESTER_SECONDS;
}

async function endSemester() {
  await ethers.provider.send("evm_increaseTime", [SEMESTER_SECONDS + 10]);
  await ethers.provider.send("evm_mine", []);
}

describe("BlockAttend", function () {
  async function setup() {
    const [admin, faculty, student, outsider, faculty2] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("BlockAttend");
    const c = await Factory.deploy();
    await c.waitForDeployment();
    await c.authorizeFaculty(faculty.address);
    await c.authorizeStudent(student.address);
    await c.connect(faculty).createCourse("Blockchain", "CS425", "Course", "Fall 2026", "Mon 10:00", 75);
    await c.connect(faculty).setSemesterSession(1, await semesterEnd());
    await c.connect(student).requestEnrollment(1);
    await c.connect(faculty).approveStudent(1, student.address);
    await c.connect(student).enroll(1);
    return { c, admin, faculty, student, outsider, faculty2 };
  }

  it("requires admin authorization for faculty", async function () {
    const { c, outsider } = await setup();
    await expect(c.connect(outsider).authorizeFaculty(outsider.address)).to.be.reverted;
  });

  it("admin can only authorize wallets: it cannot create courses or become a student", async function () {
    const { c, admin } = await setup();
    await expect(c.createCourse("X", "X1", "", "", "", 75)).to.be.reverted;
    await expect(c.authorizeStudent(admin.address)).to.be.reverted;
    await expect(c.authorizeFaculty(admin.address)).to.be.reverted;
  });

  it("only the admin can authorize or revoke student wallets, and students cannot self-register", async function () {
    const { c, student, outsider } = await setup();
    expect(c.registerStudent).to.equal(undefined);
    await expect(c.connect(outsider).authorizeStudent(outsider.address)).to.be.reverted;
    await expect(c.connect(student).revokeStudent(student.address)).to.be.reverted;
    await expect(c.connect(outsider).requestEnrollment(1)).to.be.reverted;
    await c.authorizeStudent(outsider.address);
    await c.connect(outsider).requestEnrollment(1);
    await c.revokeStudent(outsider.address);
    await expect(c.connect(outsider).enroll(1)).to.be.reverted;
    const [wallets, active] = await c.getStudents();
    expect(wallets).to.deep.equal([student.address, outsider.address]);
    expect(active).to.deep.equal([true, false]);
  });

  it("a faculty wallet cannot be authorized as student and vice versa", async function () {
    const { c, faculty, student } = await setup();
    await expect(c.authorizeStudent(faculty.address)).to.be.reverted;
    await expect(c.authorizeFaculty(student.address)).to.be.reverted;
  });

  it("an unverified wallet cannot create courses", async function () {
    const { c, outsider } = await setup();
    await expect(c.connect(outsider).createCourse("X", "X1", "", "", "", 75)).to.be.reverted;
  });

  it("admin can revoke faculty, who then loses access", async function () {
    const { c, faculty } = await setup();
    await c.revokeFaculty(faculty.address);
    await expect(c.connect(faculty).startSession(1, 5)).to.be.reverted;
    const [wallets, active] = await c.getFaculty();
    expect(wallets[0]).to.equal(faculty.address);
    expect(active[0]).to.equal(false);
  });

  it("prevents unauthorized enrollment", async function () {
    const { c, outsider } = await setup();
    await c.authorizeStudent(outsider.address);
    await expect(c.connect(outsider).enroll(1)).to.be.reverted;
  });

  it("lists pending requests and lets faculty reject", async function () {
    const { c, faculty, outsider } = await setup();
    await c.authorizeStudent(outsider.address);
    await c.connect(outsider).requestEnrollment(1);
    expect(await c.getPendingRequests(1)).to.deep.equal([outsider.address]);
    await expect(c.connect(outsider).rejectStudent(1, outsider.address)).to.be.reverted;
    await c.connect(faculty).rejectStudent(1, outsider.address);
    expect(await c.getPendingRequests(1)).to.deep.equal([]);
    await expect(c.connect(outsider).enroll(1)).to.be.reverted;
  });

  it("faculty marks attendance once and eligibility is calculated", async function () {
    const { c, faculty, student } = await setup();
    await c.connect(faculty).startSession(1, 10);
    await c.connect(faculty).markAttendance(1, student.address);
    await expect(c.connect(faculty).markAttendance(1, student.address)).to.be.reverted;
    const result = await c.getStudentStats(1, student.address);
    expect(result.attended).to.equal(1n);
    expect(result.total).to.equal(1n);
    expect(result.percentage).to.equal(100n);
    // The semester is still running, so eligibility is not decided yet.
    expect(result.eligible).to.equal(false);
    await endSemester();
    expect((await c.getStudentStats(1, student.address)).eligible).to.equal(true);
  });

  it("students cannot mark their own attendance", async function () {
    const { c, faculty, student } = await setup();
    await c.connect(faculty).startSession(1, 10);
    await expect(c.connect(student).markAttendance(1, student.address)).to.be.reverted;
  });

  it("rejects a session longer than 10 minutes (or 0)", async function () {
    const { c, faculty } = await setup();
    await expect(c.connect(faculty).startSession(1, 11)).to.be.reverted;
    await expect(c.connect(faculty).startSession(1, 0)).to.be.reverted;
    await c.connect(faculty).startSession(1, 10);
  });

  it("prevents non-owner faculty from running or marking a course session", async function () {
    const { c, faculty, student, faculty2 } = await setup();
    await c.authorizeFaculty(faculty2.address);
    await expect(c.connect(faculty2).startSession(1, 5)).to.be.reverted;
    await c.connect(faculty).startSession(1, 5);
    await expect(c.connect(faculty2).markAttendance(1, student.address)).to.be.reverted;
  });

  it("rejects attendance for a non-enrolled student", async function () {
    const { c, faculty, outsider } = await setup();
    await c.authorizeStudent(outsider.address);
    await c.connect(faculty).startSession(1, 5);
    await expect(c.connect(faculty).markAttendance(1, outsider.address)).to.be.reverted;
  });

  it("rejects attendance after session expiry", async function () {
    const { c, faculty, student } = await setup();
    await c.connect(faculty).startSession(1, 1);
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);
    await expect(c.connect(faculty).markAttendance(1, student.address)).to.be.reverted;
  });

  it("rejects attendance after the session is closed and records who closed it", async function () {
    const { c, faculty, student } = await setup();
    await c.connect(faculty).startSession(1, 5);
    await c.connect(faculty).closeSession(1);
    expect((await c.getSession(1)).closedBy).to.equal(faculty.address);
    await expect(c.connect(faculty).markAttendance(1, student.address)).to.be.reverted;
  });

  it("session summary lists present and absent students", async function () {
    const { c, faculty, student, outsider } = await setup();
    await c.authorizeStudent(outsider.address);
    await c.connect(faculty).approveStudent(1, outsider.address);
    await c.connect(outsider).enroll(1);
    await c.connect(faculty).startSession(1, 5);
    await c.connect(faculty).markAttendance(1, student.address);
    const [present, absent] = await c.getSessionAttendance(1);
    expect(present).to.deep.equal([student.address]);
    expect(absent).to.deep.equal([outsider.address]);
  });

  it("faculty cannot change the threshold or any course setting once set", async function () {
    const { c, faculty } = await setup();
    expect(c.setThreshold).to.equal(undefined);
    expect((await c.getCourse(1)).threshold).to.equal(75n);
    expect(c.updateCourse).to.equal(undefined);
  });

  it("faculty name can be set once only", async function () {
    const { c, faculty } = await setup();
    await c.connect(faculty).setFacultyName("Dr. Rao");
    await expect(c.connect(faculty).setFacultyName("Someone Else")).to.be.reverted;
    expect(await c.getFacultyName(faculty.address)).to.equal("Dr. Rao");
  });

  it("semester session can be set once, only by the course faculty, and gates attendance sessions", async function () {
    const { c, faculty, faculty2, student } = await setup();
    await c.authorizeFaculty(faculty2.address);
    await expect(c.connect(faculty).setSemesterSession(1, await semesterEnd())).to.be.reverted; // already set
    await expect(c.connect(faculty2).setSemesterSession(1, await semesterEnd())).to.be.reverted;
    await expect(c.connect(student).setSemesterSession(1, await semesterEnd())).to.be.reverted;

    await c.connect(faculty).createCourse("Networks", "CS301", "", "Fall 2026", "Tue", 60);
    // no semester session yet: attendance sessions cannot start
    await expect(c.connect(faculty).startSession(2, 5)).to.be.reverted;
    // end date in the past is rejected
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(c.connect(faculty).setSemesterSession(2, now - 10)).to.be.reverted;
    await c.connect(faculty).setSemesterSession(2, await semesterEnd());
    await c.connect(faculty).startSession(2, 5);

    // after the semester ends no new attendance sessions can start
    await endSemester();
    await expect(c.connect(faculty).startSession(1, 5)).to.be.reverted;
    const info = await c.getSemesterSession(1);
    expect(info.set).to.equal(true);
    expect(info.ended).to.equal(true);
  });

  it("applies each course's own threshold (75% vs 60%)", async function () {
    const { c, faculty, student } = await setup();
    await c.connect(faculty).createCourse("Networks", "CS301", "", "Fall 2026", "Tue", 60);
    await c.connect(student).requestEnrollment(2);
    await c.connect(faculty).approveStudent(2, student.address);
    await c.connect(student).enroll(2);
    await c.connect(faculty).setSemesterSession(2, await semesterEnd());
    // 3 of 4 sessions attended = 75% in both courses is too clean, so attend 2 of 3 = 66%
    for (const course of [1, 2]) {
      for (let i = 0; i < 3; i++) await c.connect(faculty).startSession(course, 5);
    }
    // sessions: course1 -> 1,2,3 ; course2 -> 4,5,6
    await c.connect(faculty).markAttendance(1, student.address);
    await c.connect(faculty).markAttendance(2, student.address);
    await c.connect(faculty).markAttendance(4, student.address);
    await c.connect(faculty).markAttendance(5, student.address);
    await endSemester();
    const a = await c.getStudentStats(1, student.address);
    const b = await c.getStudentStats(2, student.address);
    expect(a.percentage).to.equal(66n);
    expect(a.eligible).to.equal(false); // needs 75
    expect(b.percentage).to.equal(66n);
    expect(b.eligible).to.equal(true);  // needs 60
  });
});

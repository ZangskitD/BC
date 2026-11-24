// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BlockAttend
/// @notice On-chain course enrolment, faculty and student profiles,
/// session attendance and exam eligibility.
/// The institution admin only verifies (authorizes / revokes) faculty and student wallets.
contract BlockAttend {
    /// @notice Fixed institution admin wallet, regardless of who deploys the contract.
    address public constant institutionAdmin = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    uint256 public nextCourseId = 1;
    uint256 public nextSessionId = 1;

    enum Role {
        None,
        Faculty,
        Student
    }

    struct User {
        Role role;
        bool active;
    }

    struct Course {
        uint256 id;
        address faculty;
        string name;
        string code;
        string description;
        string semester;
        string schedule;
        uint8 threshold;
        bool active;
        uint256 totalSessions;
    }

    struct Session {
        uint256 id;
        uint256 courseId;
        uint64 expiresAt;
        bool open;
        bool counted;
        uint64 startedAt;
        address closedBy; // zero address = still open, or ended by expiry
    }

    mapping(address => User) public users;

    // Faculty profiles
    mapping(address => string) public facultyNames;

    // Student profiles stored on-chain and linked to wallet addresses
    mapping(address => string) public studentNames;
    mapping(address => string) public studentRollNumbers;

    mapping(uint256 => Course) private courses;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => uint256[]) private courseSessionIds;
    mapping(uint256 => uint256[]) private courseStudentList;

    mapping(uint256 => mapping(address => bool)) public approved;
    mapping(uint256 => mapping(address => bool)) public enrolled;
    mapping(uint256 => mapping(address => bool)) public enrollmentRequested;
    mapping(uint256 => mapping(address => bool)) public attendance;
    mapping(uint256 => mapping(address => uint256)) public attendedCount;
    mapping(uint256 => mapping(address => bool)) public studentListed;
    mapping(uint256 => mapping(address => uint256)) private studentCourseAttendance;
    mapping(uint256 => mapping(address => bool)) public sessionCancelled;

    uint256[] private allCourseIds;

    // Faculty directory (for the admin view)
    address[] private facultyList;
    mapping(address => bool) private facultyListed;

    // Student directory (for the admin view)
    address[] private studentList;
    mapping(address => bool) private studentListedByAdmin;

    // Semester session per course: set once by the course faculty, then locked.
    // Eligibility is only decided once the semester has ended.
    mapping(uint256 => uint64) public semesterStart;
    mapping(uint256 => uint64) public semesterEnd;

    // Everyone who ever requested a course (pending list is derived from this)
    mapping(uint256 => address[]) private requestList;
    mapping(uint256 => mapping(address => bool)) private requestListed;

    // Students marked present in each session, in order of marking
    mapping(uint256 => address[]) private sessionAttendees;

    uint32 public constant MAX_SESSION_MINUTES = 10;

    event UserRegistered(address indexed wallet, Role role);

    event FacultyNameUpdated(
        address indexed faculty,
        string name
    );

    event StudentProfileUpdated(
        address indexed student,
        string name,
        string rollNumber
    );

    event CourseCreated(
        uint256 indexed courseId,
        address indexed faculty,
        string code
    );

    event StudentApproved(
        uint256 indexed courseId,
        address indexed student
    );

    event EnrollmentRequested(
        uint256 indexed courseId,
        address indexed student
    );

    event StudentEnrolled(
        uint256 indexed courseId,
        address indexed student
    );

    event StudentRemoved(
        uint256 indexed courseId,
        address indexed student
    );

    event SessionStarted(
        uint256 indexed sessionId,
        uint256 indexed courseId,
        uint64 expiresAt
    );

    event SessionClosed(
        uint256 indexed sessionId,
        uint256 indexed courseId
    );

    event AttendanceRecorded(
        uint256 indexed sessionId,
        uint256 indexed courseId,
        address indexed student
    );

    event FacultyAuthorized(address indexed faculty);

    event FacultyRevoked(address indexed faculty);

    event StudentRejected(
        uint256 indexed courseId,
        address indexed student
    );

    event StudentAuthorized(address indexed student);

    event StudentRevoked(address indexed student);

    event SemesterSessionSet(
        uint256 indexed courseId,
        uint64 startsAt,
        uint64 endsAt
    );

    error Unauthorized();
    error InvalidInput();
    error NotFound();
    error NotApproved();
    error AlreadyDone();
    error SessionUnavailable();
    error SemesterNotActive();

    constructor() {
        // The admin has one job only: verifying faculty and student wallets.
    }

    modifier onlyAdmin() {
        if (msg.sender != institutionAdmin) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyFaculty() {
        if (
            users[msg.sender].role != Role.Faculty ||
            !users[msg.sender].active
        ) {
            revert Unauthorized();
        }
        _;
    }

    modifier onlyStudent() {
        if (
            users[msg.sender].role != Role.Student ||
            !users[msg.sender].active
        ) {
            revert Unauthorized();
        }
        _;
    }

    // --------------------------------------------------
    // USER REGISTRATION AND PROFILES
    // --------------------------------------------------

    /// @notice Admin authorizes a student wallet. Students can no longer self-register.
    function authorizeStudent(address wallet) external onlyAdmin {
        if (
            wallet == address(0) ||
            wallet == institutionAdmin ||
            users[wallet].role == Role.Faculty
        ) {
            revert InvalidInput();
        }

        users[wallet] = User(Role.Student, true);

        if (!studentListedByAdmin[wallet]) {
            studentListedByAdmin[wallet] = true;
            studentList.push(wallet);
        }

        emit UserRegistered(wallet, Role.Student);
        emit StudentAuthorized(wallet);
    }

    function revokeStudent(address wallet) external onlyAdmin {
        if (users[wallet].role != Role.Student) {
            revert NotFound();
        }

        users[wallet].active = false;

        emit StudentRevoked(wallet);
    }

    /// @notice All student wallets the admin has ever authorized, and whether each is still active.
    function getStudents()
        external
        view
        returns (address[] memory wallets, bool[] memory active)
    {
        wallets = studentList;
        active = new bool[](wallets.length);

        for (uint256 i; i < wallets.length; i++) {
            active[i] = users[wallets[i]].active;
        }
    }

    function authorizeFaculty(address wallet) external onlyAdmin {
        if (
            wallet == address(0) ||
            wallet == institutionAdmin ||
            users[wallet].role == Role.Student
        ) {
            revert InvalidInput();
        }

        users[wallet] = User(Role.Faculty, true);

        if (!facultyListed[wallet]) {
            facultyListed[wallet] = true;
            facultyList.push(wallet);
        }

        emit UserRegistered(wallet, Role.Faculty);
        emit FacultyAuthorized(wallet);
    }

    function revokeFaculty(address wallet) external onlyAdmin {
        if (users[wallet].role != Role.Faculty) {
            revert NotFound();
        }

        users[wallet].active = false;

        emit FacultyRevoked(wallet);
    }

    /// @notice All wallets the admin has ever authorized, and whether each is still active.
    function getFaculty()
        external
        view
        returns (address[] memory wallets, bool[] memory active)
    {
        wallets = facultyList;
        active = new bool[](wallets.length);

        for (uint256 i; i < wallets.length; i++) {
            active[i] = users[wallets[i]].active;
        }
    }

    /// @notice Save the name associated with the caller's faculty wallet.
    /// It can be set only once and cannot be changed afterwards.
    function setFacultyName(
        string calldata name
    ) external onlyFaculty {
        if (bytes(name).length == 0 || bytes(name).length > 100) {
            revert InvalidInput();
        }

        if (bytes(facultyNames[msg.sender]).length != 0) {
            revert AlreadyDone();
        }

        facultyNames[msg.sender] = name;

        emit FacultyNameUpdated(msg.sender, name);
    }

    /// @notice Retrieve a faculty name using its wallet address.
    function getFacultyName(
        address wallet
    ) external view returns (string memory) {
        return facultyNames[wallet];
    }

    /// @notice Save the student's name and roll number on-chain (once only).
    /// The profile is associated with the student's connected wallet.
    function setStudentProfile(
        string calldata name,
        string calldata rollNumber
    ) external onlyStudent {
        if (
            bytes(name).length == 0 ||
            bytes(name).length > 100 ||
            bytes(rollNumber).length == 0 ||
            bytes(rollNumber).length > 50
        ) {
            revert InvalidInput();
        }

        // The profile can be set only once and cannot be changed afterwards.
        if (bytes(studentNames[msg.sender]).length != 0) {
            revert AlreadyDone();
        }

        studentNames[msg.sender] = name;
        studentRollNumbers[msg.sender] = rollNumber;

        emit StudentProfileUpdated(
            msg.sender,
            name,
            rollNumber
        );
    }

    /// @notice Retrieve a student's name and roll number using their wallet.
    function getStudentProfile(
        address wallet
    )
        external
        view
        returns (
            string memory name,
            string memory rollNumber
        )
    {
        return (
            studentNames[wallet],
            studentRollNumbers[wallet]
        );
    }

    // --------------------------------------------------
    // COURSE MANAGEMENT
    // --------------------------------------------------

    function createCourse(
        string calldata name,
        string calldata code,
        string calldata description,
        string calldata semester,
        string calldata schedule,
        uint8 threshold
    ) external onlyFaculty returns (uint256 id) {
        if (
            bytes(name).length == 0 ||
            bytes(code).length == 0 ||
            threshold > 100
        ) {
            revert InvalidInput();
        }

        id = nextCourseId++;

        courses[id] = Course({
            id: id,
            faculty: msg.sender,
            name: name,
            code: code,
            description: description,
            semester: semester,
            schedule: schedule,
            threshold: threshold,
            active: true,
            totalSessions: 0
        });

        allCourseIds.push(id);

        emit CourseCreated(id, msg.sender, code);
    }

    function getCourse(
        uint256 id
    ) external view returns (Course memory) {
        if (courses[id].id == 0) {
            revert NotFound();
        }

        return courses[id];
    }

    function getAllCourseIds()
        external
        view
        returns (uint256[] memory)
    {
        return allCourseIds;
    }

    function getMyCourseIds()
        external
        view
        returns (uint256[] memory result)
    {
        uint256 count;

        for (uint256 i; i < allCourseIds.length; i++) {
            Course storage c = courses[allCourseIds[i]];

            if (
                c.faculty == msg.sender ||
                enrolled[c.id][msg.sender] ||
                approved[c.id][msg.sender] ||
                enrollmentRequested[c.id][msg.sender]
            ) {
                count++;
            }
        }

        result = new uint256[](count);

        uint256 j;

        for (uint256 i; i < allCourseIds.length; i++) {
            Course storage c = courses[allCourseIds[i]];

            if (
                c.faculty == msg.sender ||
                enrolled[c.id][msg.sender] ||
                approved[c.id][msg.sender] ||
                enrollmentRequested[c.id][msg.sender]
            ) {
                result[j++] = c.id;
            }
        }
    }

    // --------------------------------------------------
    // STUDENT ENROLLMENT
    // --------------------------------------------------

    function approveStudent(
        uint256 courseId,
        address student
    ) external {
        Course storage c = courses[courseId];

        if (c.id == 0) {
            revert NotFound();
        }

        if (c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (
            users[student].role != Role.Student ||
            !users[student].active
        ) {
            revert NotApproved();
        }

        approved[courseId][student] = true;

        emit StudentApproved(courseId, student);
    }

    function requestEnrollment(
        uint256 courseId
    ) external onlyStudent {
        if (
            courses[courseId].id == 0 ||
            !courses[courseId].active
        ) {
            revert NotFound();
        }

        if (enrolled[courseId][msg.sender]) {
            revert AlreadyDone();
        }

        enrollmentRequested[courseId][msg.sender] = true;

        if (!requestListed[courseId][msg.sender]) {
            requestListed[courseId][msg.sender] = true;
            requestList[courseId].push(msg.sender);
        }

        emit EnrollmentRequested(courseId, msg.sender);
    }

    /// @notice Faculty rejects a pending request (or withdraws an approval
    /// for a student who has not enrolled yet).
    function rejectStudent(
        uint256 courseId,
        address student
    ) external {
        Course storage c = courses[courseId];

        if (c.id == 0) {
            revert NotFound();
        }

        if (c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (enrolled[courseId][student]) {
            revert AlreadyDone();
        }

        enrollmentRequested[courseId][student] = false;
        approved[courseId][student] = false;

        emit StudentRejected(courseId, student);
    }

    /// @notice Students who requested this course and are still waiting.
    function getPendingRequests(
        uint256 courseId
    ) external view returns (address[] memory result) {
        address[] storage list = requestList[courseId];

        uint256 count;

        for (uint256 i; i < list.length; i++) {
            if (
                enrollmentRequested[courseId][list[i]] &&
                !enrolled[courseId][list[i]]
            ) {
                count++;
            }
        }

        result = new address[](count);

        uint256 j;

        for (uint256 i; i < list.length; i++) {
            if (
                enrollmentRequested[courseId][list[i]] &&
                !enrolled[courseId][list[i]]
            ) {
                result[j++] = list[i];
            }
        }
    }

    function enroll(uint256 courseId) external onlyStudent {
        Course storage c = courses[courseId];

        if (c.id == 0 || !c.active) {
            revert NotFound();
        }

        if (!approved[courseId][msg.sender]) {
            revert NotApproved();
        }

        if (enrolled[courseId][msg.sender]) {
            revert AlreadyDone();
        }

        enrolled[courseId][msg.sender] = true;
        enrollmentRequested[courseId][msg.sender] = false;

        if (!studentListed[courseId][msg.sender]) {
            studentListed[courseId][msg.sender] = true;

            courseStudentList[courseId].push(
                uint256(uint160(msg.sender))
            );
        }

        emit StudentEnrolled(courseId, msg.sender);
    }

    function removeStudent(
        uint256 courseId,
        address student
    ) external {
        Course storage c = courses[courseId];

        if (c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (!enrolled[courseId][student]) {
            revert NotFound();
        }

        enrolled[courseId][student] = false;

        emit StudentRemoved(courseId, student);
    }

    function getCourseStudents(
        uint256 courseId
    ) external view returns (address[] memory result) {
        uint256[] storage raw = courseStudentList[courseId];

        uint256 count;

        for (uint256 i; i < raw.length; i++) {
            if (enrolled[courseId][address(uint160(raw[i]))]) {
                count++;
            }
        }

        result = new address[](count);

        uint256 j;

        for (uint256 i; i < raw.length; i++) {
            address a = address(uint160(raw[i]));

            if (enrolled[courseId][a]) {
                result[j++] = a;
            }
        }
    }

    // --------------------------------------------------
    // ATTENDANCE SESSIONS
    // --------------------------------------------------

    function startSession(
        uint256 courseId,
        uint32 durationMinutes
    ) external onlyFaculty returns (uint256 id) {
        Course storage c = courses[courseId];

        if (c.id == 0 || c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (
            durationMinutes == 0 ||
            durationMinutes > MAX_SESSION_MINUTES
        ) {
            revert InvalidInput();
        }

        // Attendance sessions can only run inside the course's semester session.
        if (
            semesterEnd[courseId] == 0 ||
            block.timestamp > semesterEnd[courseId]
        ) {
            revert SemesterNotActive();
        }

        id = nextSessionId++;

        uint64 expiry = uint64(
            block.timestamp +
            uint256(durationMinutes) * 60
        );

        sessions[id] = Session({
            id: id,
            courseId: courseId,
            expiresAt: expiry,
            open: true,
            counted: true,
            startedAt: uint64(block.timestamp),
            closedBy: address(0)
        });

        courseSessionIds[courseId].push(id);
        c.totalSessions++;

        emit SessionStarted(id, courseId, expiry);
    }

    function closeSession(uint256 sessionId) external {
        Session storage s = sessions[sessionId];

        if (s.id == 0) {
            revert NotFound();
        }

        Course storage c = courses[s.courseId];

        if (c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (!s.open) {
            revert AlreadyDone();
        }

        s.open = false;
        s.closedBy = msg.sender;

        emit SessionClosed(sessionId, s.courseId);
    }

    /// @notice Faculty records attendance for a student they have just
    /// scanned in class. Only the faculty who owns the course can do this.
    function markAttendance(
        uint256 sessionId,
        address student
    ) external onlyFaculty {
        Session storage s = sessions[sessionId];

        if (s.id == 0) {
            revert NotFound();
        }

        if (courses[s.courseId].faculty != msg.sender) {
            revert Unauthorized();
        }

        if (
            !s.open ||
            block.timestamp > s.expiresAt ||
            !enrolled[s.courseId][student]
        ) {
            revert SessionUnavailable();
        }

        if (attendance[sessionId][student]) {
            revert AlreadyDone();
        }

        attendance[sessionId][student] = true;
        sessionAttendees[sessionId].push(student);

        attendedCount[s.courseId][student]++;

        emit AttendanceRecorded(
            sessionId,
            s.courseId,
            student
        );
    }

    /// @notice Present students (in order marked) and enrolled students who are absent.
    function getSessionAttendance(
        uint256 sessionId
    )
        external
        view
        returns (address[] memory present, address[] memory absent)
    {
        Session storage s = sessions[sessionId];

        if (s.id == 0) {
            revert NotFound();
        }

        present = sessionAttendees[sessionId];

        uint256[] storage raw = courseStudentList[s.courseId];

        uint256 count;

        for (uint256 i; i < raw.length; i++) {
            address a = address(uint160(raw[i]));

            if (enrolled[s.courseId][a] && !attendance[sessionId][a]) {
                count++;
            }
        }

        absent = new address[](count);

        uint256 j;

        for (uint256 i; i < raw.length; i++) {
            address a = address(uint160(raw[i]));

            if (enrolled[s.courseId][a] && !attendance[sessionId][a]) {
                absent[j++] = a;
            }
        }
    }

    function getSessionIds(
        uint256 courseId
    ) external view returns (uint256[] memory) {
        return courseSessionIds[courseId];
    }

    function getSession(
        uint256 sessionId
    ) external view returns (Session memory) {
        if (sessions[sessionId].id == 0) {
            revert NotFound();
        }

        return sessions[sessionId];
    }

    // --------------------------------------------------
    // ELIGIBILITY AND THRESHOLDS
    // --------------------------------------------------

    /// @notice Faculty sets the semester session for the whole course. It starts now
    /// and ends at `endsAt` (unix seconds). It can be set only once and then
    /// nothing about the course (threshold, semester, dates) can be changed.
    function setSemesterSession(
        uint256 courseId,
        uint64 endsAt
    ) external onlyFaculty {
        Course storage c = courses[courseId];

        if (c.id == 0) {
            revert NotFound();
        }

        if (c.faculty != msg.sender) {
            revert Unauthorized();
        }

        if (semesterEnd[courseId] != 0) {
            revert AlreadyDone();
        }

        if (endsAt <= block.timestamp) {
            revert InvalidInput();
        }

        semesterStart[courseId] = uint64(block.timestamp);
        semesterEnd[courseId] = endsAt;

        emit SemesterSessionSet(courseId, uint64(block.timestamp), endsAt);
    }

    function getSemesterSession(
        uint256 courseId
    )
        external
        view
        returns (
            uint64 startsAt,
            uint64 endsAt,
            bool set,
            bool ended
        )
    {
        if (courses[courseId].id == 0) {
            revert NotFound();
        }

        startsAt = semesterStart[courseId];
        endsAt = semesterEnd[courseId];
        set = endsAt != 0;
        ended = set && block.timestamp > endsAt;
    }

    function getStudentStats(
        uint256 courseId,
        address student
    )
        external
        view
        returns (
            uint256 attended,
            uint256 total,
            uint256 percentage,
            uint8 threshold,
            bool eligible
        )
    {
        Course storage c = courses[courseId];

        if (c.id == 0) {
            revert NotFound();
        }

        attended = attendedCount[courseId][student];
        total = c.totalSessions;

        percentage = total == 0
            ? 0
            : (attended * 100) / total;

        threshold = c.threshold;

        // Eligibility is only decided once the semester session has ended.
        eligible =
            semesterEnd[courseId] != 0 &&
            block.timestamp > semesterEnd[courseId] &&
            total > 0 &&
            percentage >= threshold;
    }
}
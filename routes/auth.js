const router = require("express").Router();
const User = require("../models/User");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middlewares/auth.middleware");
const { sendPushToUsers } = require("../utils/onesignal");

const ADMIN_EMAIL = "cyadav591@gmail.com";

const serializeAuthUser = (user, normalizedEmail) => {
  const isAdmin = normalizedEmail === ADMIN_EMAIL;
  const isTeamApproved = user.isTeamApproved !== false;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    teamCode: user.teamCode,
    isAdmin,
    isVerified: user.isVerified,
    isTeamApproved,
    teamApprovalState: user.teamApprovalState || (isTeamApproved ? "APPROVED" : "PENDING"),
    mustChangePassword: Boolean(user.mustChangePassword),
    pnlMode: user.pnlMode,
    pnlEligibleFrom: user.pnlEligibleFrom,
    investedAmount: user.investedAmount,
    sharePercentage: user.sharePercentage,
    currentBalance: user.currentBalance,
    tradeResultNotificationsEnabled: user.tradeResultNotificationsEnabled,
    intradayStockAlertsEnabled: user.intradayStockAlertsEnabled,
    cockpitCardOrder: user.cockpitCardOrder || []
  };
};

const notifyAdminPasswordReset = async (request, userName) => {
  try {
    const admin = await User.findOne({ email: ADMIN_EMAIL }).select("_id");
    if (!admin) return;
    await sendPushToUsers({
      recipientIds: [String(admin._id)],
      name: "password_reset_request",
      headings: { en: "Password reset requested" },
      contents: { en: `${userName} (${request.email}) requested a password reset for team ${request.teamCode}.` },
      data: { type: "PASSWORD_RESET_REQUEST", requestId: String(request._id) }
    });
  } catch (err) {
    console.error("[Auth] Failed to notify admin of password reset:", err.message);
  }
};

router.post("/register", async (req, res) => {
  try {
    const { name, email, password, teamCode, investedAmount, sharePercentage } = req.body;

    if (!name || !email || !password || !teamCode) {
      return res.status(400).json({ message: "name, email, password and teamCode are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedTeamCode = String(teamCode).trim().toUpperCase();
    const exists = await User.findOne({ email: normalizedEmail, teamCode: normalizedTeamCode });
    if (exists) {
      return res.status(409).json({ message: "User already exists in this team" });
    }

    const safeInvested = Number(investedAmount || 0);
    const existingVerifiedCount = await User.countDocuments({ teamCode: normalizedTeamCode, isVerified: true });
    const isFounder = existingVerifiedCount === 0;
    const safeShare = Number(sharePercentage ?? (existingVerifiedCount ? 0 : 100));
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email: normalizedEmail,
      password: hashed,
      teamCode: normalizedTeamCode,
      isVerified: false,
      isTeamApproved: isFounder,
      teamApprovalState: isFounder ? "APPROVED" : "PENDING",
      teamApprovedAt: isFounder ? new Date() : null,
      investedAmount: safeInvested,
      currentBalance: safeInvested,
      sharePercentage: safeShare,
      pnlMode: "FUTURE_ONLY",
      pnlModeLocked: isFounder,
      pnlEligibleFrom: new Date()
    });

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      teamCode: user.teamCode,
      isVerified: user.isVerified,
      message: "Registration submitted. Account will be active after admin approval."
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to register user" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password, teamCode } = req.body;
    if (!email || !password || !teamCode) {
      return res.status(400).json({ message: "email, password and teamCode are required" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedTeamCode = String(teamCode).trim().toUpperCase();
    const user = await User.findOne({ email: normalizedEmail, teamCode: normalizedTeamCode });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    if (!user.isVerified) {
      return res.status(403).json({ message: "Account pending approval. Contact admin." });
    }
    if (user.teamApprovalState === "REJECTED") {
      return res.status(403).json({ message: "Team membership request was rejected. Contact your team." });
    }

    const isAdmin = normalizedEmail === "cyadav591@gmail.com";
    const isTeamApproved = user.isTeamApproved !== false;
    const token = jwt.sign(
      { id: user._id, teamCode: user.teamCode, email: user.email, isAdmin },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      token,
      user: serializeAuthUser(user, normalizedEmail)
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to login" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email, teamCode } = req.body;
    if (!email || !teamCode) {
      return res.status(400).json({ message: "email and teamCode are required" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedTeamCode = String(teamCode).trim().toUpperCase();
    const user = await User.findOne({ email: normalizedEmail, teamCode: normalizedTeamCode });

    if (user) {
      let request = await PasswordResetRequest.findOne({ userId: user._id, status: "PENDING" });
      if (!request) {
        request = await PasswordResetRequest.create({
          userId: user._id,
          email: normalizedEmail,
          teamCode: normalizedTeamCode
        });
      }
      await notifyAdminPasswordReset(request, user.name);
    }

    res.json({
      message: "If your account exists, a password reset request was sent to the admin. You will receive a temporary password to log in, then you must set a new password."
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to submit password reset request" });
  }
});

router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode }).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    const isTeamApproved = user.isTeamApproved !== false;
    res.json({
      ...user.toObject(),
      id: user._id,
      isTeamApproved,
      teamApprovalState: user.teamApprovalState || (isTeamApproved ? "APPROVED" : "PENDING"),
      isAdmin: user.email === "cyadav591@gmail.com"
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load profile" });
  }
});

router.get("/angelone/callback", async (req, res) => {
  try {
    const { auth_token, feed_token, refresh_token, client_code } = req.query;

    if (!auth_token || !feed_token) {
      return res.status(400).send("<h1>Authentication failed: Missing tokens from Angel One redirect.</h1>");
    }

    console.log(`[SmartAPI Callback] Received session redirect for client: ${client_code}`);
    
    // Update the in-memory session data
    const { setSessionManually } = require("../services/smartApiSession");
    setSessionManually({
      jwtToken: auth_token,
      refreshToken: refresh_token || "",
      feedToken: feed_token,
      clientCode: client_code || "USER"
    });

    // Refresh instruments list and initialize the WebSocket connection
    const { loadScripMaster, connectWebSocket } = require("../services/marketDataFeed");
    await loadScripMaster();
    await connectWebSocket(["Nifty 50", "RELIANCE", "HDFCBANK", "SBIN"]);

    // Redirect user's browser back to the frontend dashboard
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3001";
    return res.redirect(`${frontendUrl}?connected=true`);
  } catch (err) {
    console.error("[SmartAPI Callback] Error saving OAuth redirect session:", err.message);
    return res.status(500).send(`<h1>Authentication Error</h1><p>${err.message}</p>`);
  }
});

module.exports = router;

const router = require("express").Router();
const User = require("../models/User");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const bcrypt = require("bcryptjs");
const auth = require("../middlewares/auth.middleware");
const recalculateTeam = require("../utils/recalculateTeam");

const ADMIN_EMAIL = "cyadav591@gmail.com";

const ensureAdmin = async (req, res, next) => {
  try {
    const requester = await User.findById(req.user.id).select("email");
    if (!requester || requester.email !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Admin access only" });
    }
    next();
  } catch (err) {
    res.status(500).json({ message: "Failed to verify admin access" });
  }
};

router.get("/overview", auth, ensureAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    const passwordResetRequests = await PasswordResetRequest.find({ status: "PENDING" })
      .sort({ createdAt: -1 })
      .lean();
    const teams = {};
    users.forEach((u) => {
      if (!teams[u.teamCode]) {
        teams[u.teamCode] = {
          teamCode: u.teamCode,
          members: 0,
          verified: 0,
          pending: 0
        };
      }
      teams[u.teamCode].members += 1;
      if (u.isVerified) teams[u.teamCode].verified += 1;
      else teams[u.teamCode].pending += 1;
    });

    res.json({
      teams: Object.values(teams).sort((a, b) => a.teamCode.localeCompare(b.teamCode)),
      users,
      passwordResetRequests
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load admin overview" });
  }
});

router.patch("/users/:id/verify", auth, ensureAdmin, async (req, res) => {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") {
      return res.status(400).json({ message: "isVerified boolean is required" });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.isVerified = isVerified;
    if (isVerified) {
      if (!user.pnlEligibleFrom) {
        user.pnlEligibleFrom = new Date();
      }
      if (!user.pnlMode) user.pnlMode = "FUTURE_ONLY";

      const activeInTeam = await User.countDocuments({
        teamCode: user.teamCode,
        _id: { $ne: user._id },
        isVerified: true,
        isTeamApproved: { $ne: false }
      });
      if (activeInTeam === 0) {
        user.isTeamApproved = true;
        user.teamApprovalState = "APPROVED";
        user.teamApprovedAt = new Date();
        user.teamApprovedBy = null;
        user.pnlModeLocked = true;
      } else if (!user.isTeamApproved) {
        user.teamApprovalState = "PENDING";
      }
    } else {
      user.isTeamApproved = false;
      user.teamApprovalState = "PENDING";
      user.teamApprovedAt = null;
      user.teamApprovedBy = null;
      user.pnlModeLocked = false;
    }
    await user.save();
    await recalculateTeam(user.teamCode);
    res.json({ message: "User verification updated", user: { id: user._id, isVerified: user.isVerified } });
  } catch (err) {
    res.status(500).json({ message: "Failed to update verification" });
  }
});

router.patch("/password-reset-requests/:id/resolve", auth, ensureAdmin, async (req, res) => {
  try {
    const { tempPassword } = req.body;
    if (!tempPassword || String(tempPassword).length < 6) {
      return res.status(400).json({ message: "tempPassword must be at least 6 characters" });
    }

    const request = await PasswordResetRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Password reset request not found" });
    if (request.status !== "PENDING") {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }

    const user = await User.findById(request.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.password = await bcrypt.hash(String(tempPassword), 10);
    user.mustChangePassword = true;
    await user.save();

    request.status = "RESOLVED";
    request.resolvedAt = new Date();
    request.resolvedBy = req.user.id;
    await request.save();

    await PasswordResetRequest.updateMany(
      { userId: user._id, status: "PENDING", _id: { $ne: request._id } },
      { $set: { status: "REJECTED", resolvedAt: new Date(), resolvedBy: req.user.id, adminNote: "Superseded by another reset" } }
    );

    res.json({
      message: "Temporary password set. Share it with the user securely. They must change it after login.",
      tempPassword: String(tempPassword),
      user: { id: user._id, name: user.name, email: user.email, teamCode: user.teamCode }
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to resolve password reset request" });
  }
});

router.patch("/password-reset-requests/:id/reject", auth, ensureAdmin, async (req, res) => {
  try {
    const request = await PasswordResetRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Password reset request not found" });
    if (request.status !== "PENDING") {
      return res.status(400).json({ message: `Request already ${request.status.toLowerCase()}` });
    }

    request.status = "REJECTED";
    request.resolvedAt = new Date();
    request.resolvedBy = req.user.id;
    request.adminNote = String(req.body?.note || "").trim();
    await request.save();

    res.json({ message: "Password reset request rejected" });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject password reset request" });
  }
});

module.exports = router;

const router = require("express").Router();
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const auth = require("../middlewares/auth.middleware");
const teamStatus = require("../utils/teamStatus");
const recalculateTeam = require("../utils/recalculateTeam");

router.get("/balances", auth, async (req, res) => {
  try {
    const users = await User.find({ teamCode: req.user.teamCode }).select("-password").sort({ name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to load balances" });
  }
});

router.get("/team-status", auth, async (req, res) => {
  try {
    const users = await User.find({ teamCode: req.user.teamCode }).select("-password");
    const status = teamStatus(users);
    res.json({
      ...status,
      pendingApprovals: users.filter((u) => !u.isVerified).length
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team status" });
  }
});

router.get("/team-manage", auth, async (req, res) => {
  try {
    const users = await User.find({ teamCode: req.user.teamCode }).select("-password").sort({ createdAt: 1 });
    res.json({
      users,
      status: teamStatus(users)
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team management data" });
  }
});

router.patch("/team-manage/:userId", auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { sharePercentage, investedAmount, pnlMode } = req.body;

    const updates = {};
    if (typeof sharePercentage === "number") {
      updates.sharePercentage = Math.min(100, Math.max(0, sharePercentage));
    }
    if (typeof investedAmount === "number") {
      updates.investedAmount = Math.max(0, investedAmount);
    }
    if (pnlMode === "FUTURE_ONLY" || pnlMode === "FROM_START") {
      updates.pnlMode = pnlMode;
      if (pnlMode === "FUTURE_ONLY") {
        updates.pnlEligibleFrom = new Date();
      } else {
        updates.pnlEligibleFrom = new Date(0);
      }
    }

    const user = await User.findOneAndUpdate(
      { _id: userId, teamCode: req.user.teamCode },
      { $set: updates },
      { new: true }
    ).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });

    await recalculateTeam(req.user.teamCode);
    res.json({ message: "Team member updated and balances recalculated", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to update team member" });
  }
});

router.patch("/me", auth, async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body.investedAmount === "number") {
      updates.investedAmount = Math.max(0, req.body.investedAmount);
    }
    if (typeof req.body.sharePercentage === "number") {
      updates.sharePercentage = Math.min(100, Math.max(0, req.body.sharePercentage));
    }
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      updates.name = req.body.name.trim();
    }

    const user = await User.findOneAndUpdate(
      { _id: req.user.id, teamCode: req.user.teamCode },
      { $set: updates },
      { new: true }
    ).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });

    await recalculateTeam(req.user.teamCode);
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

router.patch("/me/password", auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword and newPassword are required" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }

    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode });
    if (!user) return res.status(404).json({ message: "User not found" });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ message: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update password" });
  }
});

module.exports = router;

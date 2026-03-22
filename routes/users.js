const router = require("express").Router();
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Withdrawal = require("../models/Withdrawal");
const auth = require("../middlewares/auth.middleware");
const teamStatus = require("../utils/teamStatus");
const recalculateTeam = require("../utils/recalculateTeam");
const calculateSplit = require("../utils/calculateSplit");
const Trade = require("../models/Trade");
const getRequester = async (req) =>
  User.findOne({ _id: req.user.id, teamCode: req.user.teamCode });

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
      pendingAdminApprovals: users.filter((u) => !u.isVerified).length,
      pendingTeamApprovals: users.filter((u) => u.isVerified && u.isTeamApproved === false && u.teamApprovalState === "PENDING").length
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team status" });
  }
});

router.get("/me/results", auth, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [teamUsers, monthTrades] = await Promise.all([
      User.find({ teamCode: req.user.teamCode }),
      Trade.find({
        teamCode: req.user.teamCode,
        tradeDate: { $gte: monthStart, $lt: nextMonthStart }
      }).sort({ tradeDate: 1, createdAt: 1 })
    ]);

    const currentUserId = String(req.user.id);
    const monthlyChange = monthTrades.reduce((sum, trade) => {
      const tradeDate = new Date(trade.tradeDate);
      const eligibleUsers = teamUsers.filter((user) => {
        if (!user.isVerified || user.isTeamApproved === false) return false;
        const eligibleFrom =
          user.pnlMode === "FROM_START"
            ? new Date(0)
            : user.pnlEligibleFrom
              ? new Date(user.pnlEligibleFrom)
              : new Date();
        return eligibleFrom <= tradeDate;
      });

      if (!eligibleUsers.length) {
        return sum;
      }

      const splits = calculateSplit(Number(trade.finalAmount || 0), eligibleUsers);
      const userSplit = splits.find((split) => String(split.userId) === currentUserId);
      return sum + Number(userSplit?.amountChange || 0);
    }, 0);

    const user = await User.findById(req.user.id);
    const totalChange = Number(((user?.currentBalance || 0) - (user?.investedAmount || 0)).toFixed(2));
    res.json({
      monthlyChange: Number(monthlyChange.toFixed(2)),
      totalChange
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load results" });
  }
});

router.get("/team-manage", auth, async (req, res) => {
  try {
    const users = await User.find({ teamCode: req.user.teamCode }).select("-password").sort({ createdAt: 1 });
    const pendingMembers = users.filter(
      (u) => u.isVerified && u.isTeamApproved === false && u.teamApprovalState === "PENDING"
    );
    res.json({
      users,
      pendingMembers,
      status: teamStatus(users)
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load team management data" });
  }
});

router.patch("/team-manage/:userId", auth, async (req, res) => {
  try {
    const requester = await getRequester(req);
    if (!requester || requester.isTeamApproved === false) {
      return res.status(403).json({ message: "Team membership approval required to manage team settings" });
    }

    const { userId } = req.params;
    const { sharePercentage, investedAmount, pnlMode } = req.body;

    const updates = {};
    if (typeof sharePercentage === "number") {
      updates.sharePercentage = Math.min(100, Math.max(0, sharePercentage));
    }
    if (typeof investedAmount === "number") {
      updates.investedAmount = Math.max(0, investedAmount);
    }
    const target = await User.findOne({ _id: userId, teamCode: req.user.teamCode });
    if (!target) return res.status(404).json({ message: "User not found" });

    if ((pnlMode === "FUTURE_ONLY" || pnlMode === "FROM_START") && !target.pnlModeLocked) {
      updates.pnlMode = pnlMode;
      updates.pnlModeLocked = true;
      updates.pnlEligibleFrom = pnlMode === "FUTURE_ONLY" ? new Date() : new Date(0);
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

router.patch("/team-approval/:userId", auth, async (req, res) => {
  try {
    const requester = await getRequester(req);
    if (!requester || requester.isTeamApproved === false) {
      return res.status(403).json({ message: "Only approved team members can approve requests" });
    }

    const { userId } = req.params;
    const { action, pnlMode, sharePercentage } = req.body;
    const member = await User.findOne({ _id: userId, teamCode: req.user.teamCode });
    if (!member) return res.status(404).json({ message: "User not found" });
    if (!member.isVerified) {
      return res.status(400).json({ message: "Member must be admin verified before team approval" });
    }
    if (member.teamApprovalState !== "PENDING") {
      return res.status(400).json({ message: `Membership already ${member.teamApprovalState.toLowerCase()}` });
    }
    if (String(member._id) === String(requester._id)) {
      return res.status(400).json({ message: "You cannot approve yourself" });
    }

    if (action === "REJECT") {
      member.teamApprovalState = "REJECTED";
      member.isTeamApproved = false;
      member.teamApprovedBy = requester._id;
      member.teamApprovedAt = new Date();
      await member.save();
      return res.json({ message: "Team membership rejected" });
    }

    if (action !== "APPROVE") {
      return res.status(400).json({ message: "action must be APPROVE or REJECT" });
    }
    if (pnlMode !== "FUTURE_ONLY" && pnlMode !== "FROM_START") {
      return res.status(400).json({ message: "pnlMode is required for approval" });
    }
    if (typeof sharePercentage !== "number") {
      return res.status(400).json({ message: "sharePercentage is required for approval" });
    }

    member.sharePercentage = Math.min(100, Math.max(0, sharePercentage));
    member.pnlMode = pnlMode;
    member.pnlModeLocked = true;
    member.pnlEligibleFrom = pnlMode === "FUTURE_ONLY" ? new Date() : new Date(0);
    member.teamApprovalState = "APPROVED";
    member.isTeamApproved = true;
    member.teamApprovedBy = requester._id;
    member.teamApprovedAt = new Date();
    await member.save();

    await recalculateTeam(req.user.teamCode);
    res.json({ message: "Team membership approved and balances recalculated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to process team approval" });
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
    // console.log("user",user);
    const data = await recalculateTeam(req.user.teamCode);
    // console.log({data});
    res.json(user);
  } catch (err) {
    console.log({err});
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

router.get("/me/withdrawals", auth, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({
      teamCode: req.user.teamCode,
      userId: req.user.id
    }).sort({ withdrawalDate: -1, createdAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ message: "Failed to load withdrawals" });
  }
});

router.post("/me/onesignal", auth, async (req, res) => {
  try {
    const { playerId } = req.body;
    if (!playerId) {
      return res.status(400).json({ message: "playerId is required" });
    }

    await User.updateOne(
      { _id: req.user.id, teamCode: req.user.teamCode },
      { $addToSet: { onesignalPlayerIds: playerId } }
    );
    res.json({ message: "OneSignal player registered" });
  } catch (err) {
    res.status(500).json({ message: "Failed to register OneSignal player" });
  }
});

router.delete("/me/onesignal", auth, async (req, res) => {
  try {
    const { playerId } = req.body || {};
    const update = playerId
      ? { $pull: { onesignalPlayerIds: playerId } }
      : { $set: { onesignalPlayerIds: [] } };

    await User.updateOne({ _id: req.user.id, teamCode: req.user.teamCode }, update);
    res.json({ message: "OneSignal player cleared" });
  } catch (err) {
    res.status(500).json({ message: "Failed to clear OneSignal player" });
  }
});

router.get("/team-withdrawals", auth, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ teamCode: req.user.teamCode })
      .sort({ withdrawalDate: -1, createdAt: -1 })
      .populate("userId", "name email");
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ message: "Failed to load team withdrawals" });
  }
});

router.post("/me/withdrawals", auth, async (req, res) => {
  try {
    const { amount, withdrawalDate, note } = req.body;
    const safeAmount = Number(amount);
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
      return res.status(400).json({ message: "Withdrawal amount must be a valid positive number" });
    }
    if (!withdrawalDate) {
      return res.status(400).json({ message: "withdrawalDate is required" });
    }

    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (safeAmount > Number(user.currentBalance || 0)) {
      return res.status(400).json({ message: "Withdrawal amount cannot exceed current balance" });
    }

    const wd = await Withdrawal.create({
      teamCode: req.user.teamCode,
      userId: req.user.id,
      amount: safeAmount,
      withdrawalDate: new Date(withdrawalDate),
      note: note || ""
    });

    await recalculateTeam(req.user.teamCode);
    res.status(201).json(wd);
  } catch (err) {
    res.status(500).json({ message: "Failed to add withdrawal" });
  }
});

module.exports = router;

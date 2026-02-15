const router = require("express").Router();
const User = require("../models/User");
const auth = require("../middlewares/auth.middleware");

router.get("/balances", auth, async (req, res) => {
  try {
    const users = await User.find({ teamCode: req.user.teamCode }).select("-password").sort({ name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to load balances" });
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
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

module.exports = router;

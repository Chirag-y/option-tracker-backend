const router = require("express").Router();
const Trade = require("../models/Trade");
const User = require("../models/User");
const Ledger = require("../models/Ledger");
const calculateSplit = require("../utils/calculateSplit");
const auth = require("../middlewares/auth.middleware");
const teamStatus = require("../utils/teamStatus");

router.get("/", auth, async (req, res) => {
  try {
    const { month } = req.query;
    const query = { teamCode: req.user.teamCode };

    if (month) {
      const start = new Date(`${month}-01T00:00:00.000Z`);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      query.tradeDate = { $gte: start, $lt: end };
    }

    const trades = await Trade.find(query).sort({ tradeDate: -1, createdAt: -1 });
    res.json(trades);
  } catch (err) {
    res.status(500).json({ message: "Failed to load trades" });
  }
});

router.get("/monthly-summary", auth, async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { teamCode: req.user.teamCode } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$tradeDate" } },
          netPnl: { $sum: "$finalAmount" },
          grossAmount: { $sum: "$amount" },
          totalCharges: { $sum: "$charges" },
          tradesCount: { $sum: 1 }
        }
      },
      { $sort: { _id: -1 } }
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to load monthly summary" });
  }
});

router.post("/", auth, async (req, res) => {
  try {
    const { instrument, optionType, strikePrice, resultType, amount, charges, tradeDate } = req.body;
    if (!instrument || !optionType || !resultType || typeof amount !== "number") {
      return res.status(400).json({ message: "instrument, optionType, resultType and numeric amount are required" });
    }

    const teamUsers = await User.find({ teamCode: req.user.teamCode });
    const status = teamStatus(teamUsers);
    if (!status.canTrade) {
      return res.status(400).json({
        message: `Trade entry is blocked. ${status.message}`
      });
    }

    const resolvedTradeDate = tradeDate ? new Date(tradeDate) : new Date();
    const safeAmount = Math.max(0, amount);
    const safeCharges = Math.max(0, Number(charges || 0));
    const finalAmount =
      resultType === "PROFIT" ? safeAmount - safeCharges : -(safeAmount + safeCharges);

    const trade = await Trade.create({
      teamCode: req.user.teamCode,
      createdBy: req.user.id,
      instrument: String(instrument).trim(),
      optionType,
      strikePrice: Number(strikePrice || 0),
      resultType,
      amount: safeAmount,
      charges: safeCharges,
      finalAmount: Number(finalAmount.toFixed(2)),
      tradeDate: resolvedTradeDate
    });

    const users = teamUsers.filter((u) => {
      if (!u.isVerified) return false;
      const eligibleFrom = u.pnlEligibleFrom ? new Date(u.pnlEligibleFrom) : new Date(0);
      return eligibleFrom <= resolvedTradeDate;
    });
    if (!users.length) {
      return res.status(400).json({ message: "No eligible verified team members found for this trade date" });
    }
    const splits = calculateSplit(trade.finalAmount, users);

    for (const s of splits) {
      const user = await User.findOne({ _id: s.userId, teamCode: req.user.teamCode });
      user.currentBalance = Number((user.currentBalance + s.amountChange).toFixed(2));
      await user.save();

      await Ledger.create({
        teamCode: req.user.teamCode,
        tradeId: trade._id,
        userId: user._id,
        amountChange: s.amountChange,
        balanceAfter: user.currentBalance
      });
    }

    res.status(201).json(trade);
  } catch (err) {
    res.status(500).json({ message: "Failed to create trade" });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.id, teamCode: req.user.teamCode });
    if (!trade) return res.status(404).json({ message: "Trade not found" });

    const ledgers = await Ledger.find({ tradeId: req.params.id, teamCode: req.user.teamCode });
    for (const l of ledgers) {
      const user = await User.findOne({ _id: l.userId, teamCode: req.user.teamCode });
      if (!user) continue;
      user.currentBalance = Number((user.currentBalance - l.amountChange).toFixed(2));
      await user.save();
    }
    await Ledger.deleteMany({ tradeId: req.params.id, teamCode: req.user.teamCode });
    await Trade.deleteOne({ _id: req.params.id, teamCode: req.user.teamCode });
    res.json({ message: "Trade deleted with rollback" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete trade" });
  }
});

module.exports = router;

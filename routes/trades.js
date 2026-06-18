const router = require("express").Router();
const Trade = require("../models/Trade");
const User = require("../models/User");
const Ledger = require("../models/Ledger");
const calculateSplit = require("../utils/calculateSplit");
const auth = require("../middlewares/auth.middleware");
const teamStatus = require("../utils/teamStatus");
const recalculateTeam = require("../utils/recalculateTeam");
const notifyTeam = require("../utils/notifyTeam");
const { buildTradeNotificationText, createNotification } = require("../utils/notifications");

router.get("/", auth, async (req, res) => {
  try {
    const { month, resultType, instrument, period, startDate, endDate } = req.query;
    const query = { teamCode: req.user.teamCode };

    if (month) {
      const start = new Date(`${month}-01T00:00:00.000Z`);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      query.tradeDate = { $gte: start, $lt: end };
    }
    if (resultType === "PROFIT" || resultType === "LOSS") {
      query.resultType = resultType;
    }
    if (instrument && instrument !== "ALL") {
      query.instrument = instrument;
    }
    if (period) {
      const now = new Date();
      let start = null;
      let end = null;
      if (period === "THIS_MONTH") {
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      } else if (period === "THIS_YEAR") {
        start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
        end = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      } else if (period === "PAST_MONTH") {
        start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      } else if (period === "CUSTOM" && startDate && endDate) {
        start = new Date(`${startDate}T00:00:00.000Z`);
        end = new Date(`${endDate}T23:59:59.999Z`);
      }
      if (start && end) {
        query.tradeDate = { $gte: start, $lte: end };
      }
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
      if (!u.isVerified || u.isTeamApproved === false) return false;
      const eligibleFrom = u.pnlEligibleFrom ? new Date(u.pnlEligibleFrom) : new Date(0);
      // console.log({u, eligibleFrom, resolvedTradeDate});
      return eligibleFrom <= resolvedTradeDate;
    });
    if (!users.length) {
      return res.status(400).json({ message: "No eligible verified team members found for this trade date" });
    }
    const splits = calculateSplit(trade.finalAmount, users);
    // console.log({splits});
    
    for (const s of splits) {
      const user = await User.findOne({ _id: s.userId, teamCode: req.user.teamCode });
      user.currentBalance = Number((user.currentBalance + s.amountChange).toFixed(2));
      // console.log({user});
      await user.save();

      await Ledger.create({
        teamCode: req.user.teamCode,
        tradeId: trade._id,
        userId: user._id,
        amountChange: s.amountChange,
        balanceAfter: user.currentBalance
      });
    }

    try {
      const recipients = teamUsers.filter(
        (u) =>
          String(u._id) !== String(req.user.id) &&
          u.isVerified &&
          u.isTeamApproved !== false &&
          u.tradeResultNotificationsEnabled !== false
      );
      const actor = teamUsers.find((u) => String(u._id) === String(req.user.id));
      await notifyTeam({
        recipientIds: recipients.map((u) => String(u._id)),
        trade,
        sender: actor?.name || req.user.email
      });
    } catch (notifErr) {
      console.error("Failed to send notification", notifErr?.message || notifErr);
    }

    try {
      const actor = teamUsers.find((u) => String(u._id) === String(req.user.id));
      const tradeText = buildTradeNotificationText(trade, actor?.name || req.user.email);
      await createNotification({
        type: "TRADE_RESULT",
        scope: "TEAM",
        teamCode: req.user.teamCode,
        title: tradeText.title,
        message: tradeText.message,
        source: "trade",
        eventType: "trade.created",
        payload: {
          trade: trade.toObject ? trade.toObject() : trade
        },
        metadata: tradeText.metadata,
        relatedTradeId: trade._id,
        createdBy: req.user.id
      });
    } catch (storeErr) {
      console.error("Failed to store trade notification:", storeErr?.message || storeErr);
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

    await Ledger.deleteMany({ tradeId: req.params.id, teamCode: req.user.teamCode });
    await Trade.deleteOne({ _id: req.params.id, teamCode: req.user.teamCode });
    await recalculateTeam(req.user.teamCode);
    res.json({ message: "Trade deleted with rollback" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete trade" });
  }
});

router.patch("/:id", auth, async (req, res) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.id, teamCode: req.user.teamCode });
    if (!trade) return res.status(404).json({ message: "Trade not found" });

    const {
      instrument,
      optionType,
      strikePrice,
      resultType,
      amount,
      charges,
      tradeDate
    } = req.body;

    if (!instrument || !resultType || typeof amount !== "number" || typeof charges !== "number" || !tradeDate) {
      return res.status(400).json({ message: "instrument, resultType, amount, charges and tradeDate are required" });
    }

    const safeAmount = Math.max(0, amount);
    const safeCharges = Math.max(0, charges);
    const finalAmount = resultType === "PROFIT" ? safeAmount - safeCharges : -(safeAmount + safeCharges);

    trade.instrument = String(instrument).trim();
    trade.optionType = optionType || trade.optionType;
    trade.strikePrice = Number(strikePrice || 0);
    trade.resultType = resultType;
    trade.amount = safeAmount;
    trade.charges = safeCharges;
    trade.finalAmount = Number(finalAmount.toFixed(2));
    trade.tradeDate = new Date(tradeDate);
    await trade.save();

    await recalculateTeam(req.user.teamCode);
    res.json(trade);
  } catch (err) {
    res.status(500).json({ message: "Failed to update trade" });
  }
});

module.exports = router;

const router = require("express").Router();
const Trade = require("../models/Trade");
const User = require("../models/User");
const Ledger = require("../models/Ledger");
const calculateSplit = require("../utils/calculateSplit");

router.post("/", async (req, res) => {
  const finalAmount =
    req.body.resultType === "PROFIT"
      ? req.body.amount - req.body.charges
      : -(req.body.amount + req.body.charges);

  const trade = await Trade.create({ ...req.body, finalAmount });

  const users = await User.find();
  const splits = calculateSplit(finalAmount, users);

  for (const s of splits) {
    const user = await User.findById(s.userId);
    user.currentBalance += s.amountChange;
    await user.save();

    await Ledger.create({
      tradeId: trade._id,
      userId: user._id,
      amountChange: s.amountChange,
      balanceAfter: user.currentBalance
    });
  }

  res.json(trade);
});

router.delete("/:id", async (req, res) => {
  const ledgers = await Ledger.find({ tradeId: req.params.id });
  for (const l of ledgers) {
    const user = await User.findById(l.userId);
    user.currentBalance -= l.amountChange;
    await user.save();
  }
  await Ledger.deleteMany({ tradeId: req.params.id });
  await Trade.findByIdAndDelete(req.params.id);
  res.json({ message: "Trade deleted with rollback" });
});

module.exports = router;
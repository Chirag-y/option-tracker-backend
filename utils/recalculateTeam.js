const Trade = require("../models/Trade");
const User = require("../models/User");
const Ledger = require("../models/Ledger");
const calculateSplit = require("./calculateSplit");

module.exports = async (teamCode) => {
  const users = await User.find({ teamCode });
  const verified = users.filter((u) => u.isVerified);
  const userMap = new Map(
    users.map((u) => [
      String(u._id),
      {
        model: u,
        balance: Number(u.investedAmount || 0)
      }
    ])
  );

  await Ledger.deleteMany({ teamCode });
  const trades = await Trade.find({ teamCode }).sort({ tradeDate: 1, createdAt: 1 });

  for (const trade of trades) {
    const tradeDate = new Date(trade.tradeDate);
    const eligible = verified.filter((u) => {
      const eligibleFrom = u.pnlEligibleFrom ? new Date(u.pnlEligibleFrom) : new Date(0);
      return eligibleFrom <= tradeDate;
    });
    if (!eligible.length) continue;

    const splits = calculateSplit(trade.finalAmount, eligible);
    for (const split of splits) {
      const key = String(split.userId);
      const userState = userMap.get(key);
      if (!userState) continue;
      userState.balance = Number((userState.balance + split.amountChange).toFixed(2));
      await Ledger.create({
        teamCode,
        tradeId: trade._id,
        userId: split.userId,
        amountChange: split.amountChange,
        balanceAfter: userState.balance
      });
    }
  }

  for (const [, state] of userMap) {
    state.model.currentBalance = Number(state.balance.toFixed(2));
    await state.model.save();
  }
};

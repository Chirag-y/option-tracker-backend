module.exports = (users) => {
  const verified = users.filter((u) => u.isVerified);
  const verifiedCount = verified.length;
  if (!verifiedCount) {
    return {
      canTrade: false,
      verifiedCount: 0,
      shareTotal: 0,
      message: "No verified team members found."
    };
  }

  const shareTotal = Number(
    verified.reduce((sum, u) => sum + Number(u.sharePercentage || 0), 0).toFixed(2)
  );
  const allPositive = verified.every((u) => Number(u.sharePercentage || 0) > 0);
  const sumOk = Math.abs(shareTotal - 100) <= 0.01;
  const canTrade = allPositive && sumOk;

  let message = "Team share configuration is valid.";
  if (!allPositive) {
    message = "All verified members must have share percentage > 0. Please rebalance team shares.";
  } else if (!sumOk) {
    message = `Total share must be exactly 100%. Current total is ${shareTotal}%.`;
  }

  return {
    canTrade,
    verifiedCount,
    shareTotal,
    message
  };
};

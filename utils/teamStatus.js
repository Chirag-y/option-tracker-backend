module.exports = (users) => {
  const activeMembers = users.filter((u) => u.isVerified && u.isTeamApproved !== false);
  const activeCount = activeMembers.length;
  if (!activeCount) {
    return {
      canTrade: false,
      verifiedCount: 0,
      shareTotal: 0,
      message: "No active team members found. Team approvals are required."
    };
  }

  const shareTotal = Number(
    activeMembers.reduce((sum, u) => sum + Number(u.sharePercentage || 0), 0).toFixed(2)
  );
  const allPositive = activeMembers.every((u) => Number(u.sharePercentage || 0) > 0);
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
    verifiedCount: activeCount,
    shareTotal,
    message
  };
};

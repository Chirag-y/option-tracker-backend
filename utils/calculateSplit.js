module.exports = (finalAmount, users) => {
  if (!users.length) return [];

  const totalShare = users.reduce((sum, u) => sum + Number(u.sharePercentage || 0), 0);
  if (totalShare <= 0) {
    throw new Error("Team share percentages are not configured");
  }

  const changes = users.map((u) => ({
    userId: u._id,
    amountChange: (finalAmount * Number(u.sharePercentage || 0)) / totalShare
  }));
  // console.log({users})
  const rounded = changes.map((c) => ({
    ...c,
    amountChange: Number(c.amountChange.toFixed(2))
  }));

  const drift = Number(
    (Number(finalAmount.toFixed(2)) - rounded.reduce((s, c) => s + c.amountChange, 0)).toFixed(2)
  );

  if (drift !== 0) {
    rounded[rounded.length - 1].amountChange = Number(
      (rounded[rounded.length - 1].amountChange + drift).toFixed(2)
    );
  }

  return rounded;
};

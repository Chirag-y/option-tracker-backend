module.exports = (finalAmount, users) => {
  return users.map(u => ({
    userId: u._id,
    amountChange: (finalAmount * u.sharePercentage) / 100
  }));
};
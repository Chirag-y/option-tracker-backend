const router = require("express").Router();
const auth = require("../middlewares/auth.middleware");
const Notification = require("../models/Notification");
const User = require("../models/User");

const allowedTypesForUser = (user) => {
  const types = [];
  if (user?.tradeResultNotificationsEnabled !== false) {
    types.push("TRADE_RESULT");
  }
  if (user?.intradayStockAlertsEnabled !== false) {
    types.push("WEBHOOK_ALERT");
  }
  return types;
};

const visibleScopeQuery = (teamCode, userId) => ({
  $or: [
    { scope: "GLOBAL" },
    { scope: "TEAM", teamCode },
    { scope: "USER", recipientUserId: userId }
  ]
});

router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode }).select(
      "teamCode tradeResultNotificationsEnabled intradayStockAlertsEnabled"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const requestedPage = Number(req.query.page);
    const requestedLimit = Number(req.query.limit);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(50, Math.floor(requestedLimit)) : 20;
    const types = allowedTypesForUser(user);
    if (!types.length) {
      return res.json({
        items: [],
        page,
        limit,
        total: 0,
        pages: 0,
        hasMore: false
      });
    }

    const query = {
      type: { $in: types },
      ...visibleScopeQuery(user.teamCode, req.user.id)
    };

    const [total, items] = await Promise.all([
      Notification.countDocuments(query),
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    const currentUserId = String(req.user.id);
    const normalizedItems = items.map((item) => ({
      ...item,
      id: String(item._id),
      isRead: Array.isArray(item.readBy) ? item.readBy.some((readerId) => String(readerId) === currentUserId) : false
    }));

    res.json({
      items: normalizedItems,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load notifications" });
  }
});

router.patch("/:notificationId/read", auth, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode }).select(
      "teamCode tradeResultNotificationsEnabled intradayStockAlertsEnabled"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const notification = await Notification.findOne({
      _id: req.params.notificationId,
      type: { $in: allowedTypesForUser(user) },
      ...visibleScopeQuery(user.teamCode, req.user.id)
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    notification.readBy = Array.from(new Set([...(notification.readBy || []).map(String), String(req.user.id)]));
    await notification.save();

    res.json({
      message: "Notification marked as read",
      id: String(notification._id)
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark notification as read" });
  }
});

router.patch("/read-all", auth, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.user.id, teamCode: req.user.teamCode }).select(
      "teamCode tradeResultNotificationsEnabled intradayStockAlertsEnabled"
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const types = allowedTypesForUser(user);
    if (!types.length) {
      return res.json({ message: "No notifications to mark as read" });
    }

    await Notification.updateMany(
      {
        type: { $in: types },
        ...visibleScopeQuery(user.teamCode, req.user.id)
      },
      { $addToSet: { readBy: req.user.id } }
    );

    res.json({ message: "Notifications marked as read" });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark notifications as read" });
  }
});

module.exports = router;

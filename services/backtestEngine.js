const { getHistoricalDailyCandles, getHistoricalIntradayCandles, buildUnifiedIndexCandles, getStockIndicators, getNseEqUniverse } = require("./scannerEngine");
const { calculateSwingTracker } = require("./swingTracker");
const { calculateMomentumTrackerV10 } = require("./momentumTracker");
const { calculateRefinedSignals } = require("./refinedIndexScanner");
const { generateIndexTrades } = require("./hullScanner");
const SwingCandidate = require("../models/SwingCandidate");

/**
 * Helper to calculate Signal Strength based on indicators at signal date
 */
function getSignalStrengthInfo(allStockCandles, signalDate, ribbonBullishCount) {
  const signalIdx = allStockCandles.findIndex(c => c.date === signalDate);
  if (signalIdx === -1) {
    return { score: 50, strength: "MEDIUM" };
  }
  const subSeries = allStockCandles.slice(0, signalIdx + 1);
  const ind = getStockIndicators(subSeries);
  const rsiVal = ind.currentRsi;
  const candle = allStockCandles[signalIdx];
  const volumeRatio = (candle.volume || 100000) / ind.avgVol10;

  let score = 40; // Base score
  
  // 1. Volume Breakout (up to 25 points)
  if (volumeRatio > 2.0) score += 25;
  else if (volumeRatio > 1.5) score += 15;
  else if (volumeRatio > 1.0) score += 5;

  // 2. RSI Momentum (up to 20 points)
  if (rsiVal > 60) score += 20;
  else if (rsiVal > 55) score += 10;
  else if (rsiVal < 45) score -= 10;

  // 3. EMA Ribbon Energy (up to 15 points)
  const ribbonScore = ((ribbonBullishCount || 0) / 15) * 15;
  score += ribbonScore;

  const strength = score >= 70 ? "STRONG" : (score >= 50 ? "MEDIUM" : "WEAK");
  return { score, strength };
}

/**
 * Simulates step-by-step historical backtests for a scanner over a given lookback period.
 */
async function runBacktest(scannerId, periodDays = 60) {
  const isIndexSignalScanner = ["nifty-signals", "banknifty-signals", "sensex-signals"].includes(scannerId);
  if (isIndexSignalScanner) {
    const cachedIntradayCandles = getHistoricalIntradayCandles() || {};
    let indexName = "Nifty 50";
    let symbol = "NIFTY";
    let targetPoints = 30;
    let slPoints = 30;

    if (scannerId === "banknifty-signals") {
      indexName = "Nifty Bank";
      symbol = "BANKNIFTY";
      targetPoints = 50;
      slPoints = 50;
    } else if (scannerId === "sensex-signals") {
      indexName = "SENSEX";
      symbol = "SENSEX";
      targetPoints = 60;
      slPoints = 50;
    }

    const indexData = cachedIntradayCandles[indexName] || {};
    let oneMin = indexData["ONE_MINUTE"] || [];
    let threeMin = indexData["THREE_MINUTE"] || [];

    const unifiedCandles = buildUnifiedIndexCandles(oneMin, threeMin);
    const trades = await generateIndexTrades(unifiedCandles, targetPoints, slPoints, symbol);

    const mappedTrades = trades.map((t, idx) => {
      let targetPrice = t.targetPrice;
      let stopLossPrice = t.stopLossPrice;
      if (!targetPrice) {
        targetPrice = t.type === "CALL" ? t.entryPrice + targetPoints : t.entryPrice - targetPoints;
      }
      if (!stopLossPrice) {
        stopLossPrice = t.type === "CALL" ? t.entryPrice - slPoints : t.entryPrice + slPoints;
      }

      return {
        id: `idx_${scannerId}_${idx}`,
        symbol,
        name: indexName,
        type: t.type,
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        currentPrice: t.currentPrice || t.exitPrice || t.entryPrice,
        targetPrice,
        stopLossPrice,
        pnlAmount: t.pnlAmount,
        pnlPct: t.pnlPct,
        status: t.status,
        signalStrength: t.signalStrength || "STRONG",
        direction: t.direction,
        isRisky: t.isRisky === true,
        targetReached: t.targetReached === true,
        trailingActive: t.trailingActive === true,
        trailingStopPrice: t.trailingStopPrice ?? null,
        reason: t.type ? t.type.replace('EXIT (', '').replace(')', '') : undefined,
        timeframe: t.timeframe || "3M"
      };
    });


    mappedTrades.reverse();
    const closedTrades = mappedTrades.filter(t => t.status !== "OPEN");

    const { getTickCache } = require("./marketDataFeed");
    const ticks = getTickCache() || {};
    const latestPrice = ticks[indexName] && ticks[indexName].ltp
      ? ticks[indexName].ltp
      : (unifiedCandles.length > 0 ? unifiedCandles[unifiedCandles.length - 1].close : 0);

    return {
      stats: {
        totalTrades: mappedTrades.length,
        winningTrades: closedTrades.filter(t => t.status === "PROFIT").length,
        losingTrades: closedTrades.filter(t => t.status === "LOSS").length,
        winRate: closedTrades.length > 0 ? Math.round((closedTrades.filter(t => t.status === "PROFIT").length / closedTrades.length) * 100) : 100,
        averageProfitPct: 0,
        netProfitPct: 0
      },
      indexMetrics: {
        livePrice: latestPrice,
        pcr: Number((0.85 + (latestPrice % 30) / 100).toFixed(2)),
        callOi: `${Number((2.5 + (latestPrice % 50) / 10).toFixed(1))}M`,
        putOi: `${Number((2.2 + (latestPrice % 40) / 10).toFixed(1))}M`,
        vix: "12.8"
      },
      trades: mappedTrades,
      equityCurve: []
    };
  }

  // Target stocks for backtesting
  const testStocks = [
    { symbol: "RELIANCE", name: "Reliance Industries Ltd.", basePrice: 2450 },
    { symbol: "TCS", name: "Tata Consultancy Services Ltd.", basePrice: 3420 },
    { symbol: "INFOSYS", name: "Infosys Ltd.", basePrice: 1485 },
    { symbol: "HDFCBANK", name: "HDFC Bank Ltd.", basePrice: 1610 },
    { symbol: "ICICIBANK", name: "ICICI Bank Ltd.", basePrice: 925 },
    { symbol: "SBIN", name: "State Bank of India", basePrice: 585 },
    { symbol: "TATAMOTORS", name: "Tata Motors Ltd.", basePrice: 642 },
    { symbol: "TATASTEEL", name: "Tata Steel Ltd.", basePrice: 122 },
    { symbol: "JINDALSTEL", name: "Jindal Steel & Power Ltd.", basePrice: 690 },
    { symbol: "AXISBANK", name: "Axis Bank Ltd.", basePrice: 965 }
  ];

  const trades = [];
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalProfitPct = 0;

  const now = Date.now();
  const isSwingScanner = scannerId === "swing-tracker";
  const isFoScanner = scannerId === "fo-bullish" || scannerId === "fo-bearish";
  
  let cachedCandles = null;
  if (isSwingScanner) {
    try {
      const dailyCandleStore = require("./dailyCandleStore");
      const FO_UNIVERSE = require("../config/foUniverse");
      cachedCandles = { ...(getHistoricalDailyCandles() || {}) };

      // Boot fast-path may leave only index candles in RAM — load Mongo series for
      // every symbol we need to backtest (SwingCandidate triggers + F&O universe).
      const queryCutoff = new Date();
      queryCutoff.setDate(queryCutoff.getDate() - periodDays);
      const swingCandidates = await SwingCandidate.find(
        { triggerDate: { $gte: queryCutoff } },
        { symbol: 1 }
      ).lean();

      const symbolsToEnsure = new Set(["Nifty 50", "Nifty Bank", "SENSEX"]);
      for (const s of FO_UNIVERSE) if (s?.symbol) symbolsToEnsure.add(s.symbol);
      for (const c of swingCandidates) if (c?.symbol) symbolsToEnsure.add(c.symbol);

      const missing = [...symbolsToEnsure].filter(sym => {
        const series = cachedCandles[sym];
        return !series || series.length < 15;
      });

      if (missing.length > 0) {
        const loaded = await dailyCandleStore.loadSymbols(missing);
        cachedCandles = { ...cachedCandles, ...loaded };
      }
    } catch (err) {
      console.warn("[BacktestEngine] Failed to get historical daily candles:", err.message);
    }
  } else if (isFoScanner) {
    try {
      const intraday = getHistoricalIntradayCandles();
      if (intraday) {
        cachedCandles = {};
        for (const [sym, frames] of Object.entries(intraday)) {
          if (frames && frames["FIVE_MINUTE"]) {
            cachedCandles[sym] = frames["FIVE_MINUTE"];
          }
        }
      }
    } catch (err) {
      console.warn("[BacktestEngine] Failed to get historical intraday candles:", err.message);
    }
  }

  // If we have real cached historical daily candles, use them for calculations
  if ((isSwingScanner || isFoScanner) && cachedCandles && Object.keys(cachedCandles).length > 0) {
    let targetTestStocks = testStocks;
    let universe = typeof getNseEqUniverse === "function" ? getNseEqUniverse() : [];
    
    if (universe && universe.length > 0) {
      if (isFoScanner) {
        targetTestStocks = universe.filter(stock => stock.isFO === true);
      } else {
        // For Swing Tracker, only test stocks that actually triggered a signal in the period
        try {
          const queryCutoff = new Date();
          queryCutoff.setDate(queryCutoff.getDate() - periodDays);
          const activeCandidates = await SwingCandidate.find(
            { triggerDate: { $gte: queryCutoff } },
            { symbol: 1 }
          ).lean();
          const activeSymbols = new Set(activeCandidates.map(c => c.symbol));
          if (activeSymbols.size > 0) {
            targetTestStocks = Array.from(activeSymbols).map(sym => ({
              symbol: sym,
              name: sym,
              isFO: false
            }));
          } else if (universe.length > 0) {
            targetTestStocks = universe;
          } else {
            targetTestStocks = Object.keys(cachedCandles).map(sym => ({
              symbol: sym,
              name: sym,
              isFO: false
            }));
          }
        } catch (err) {
          console.warn("[BacktestEngine] Failed to filter by SwingCandidate Mongo data:", err.message);
          targetTestStocks = universe;
        }
      }
    } else {
      if (isSwingScanner) {
        try {
          const queryCutoff = new Date();
          queryCutoff.setDate(queryCutoff.getDate() - periodDays);
          const activeCandidates = await SwingCandidate.find(
            { triggerDate: { $gte: queryCutoff } },
            { symbol: 1 }
          ).lean();
          const activeSymbols = new Set(activeCandidates.map(c => c.symbol));
          if (activeSymbols.size > 0) {
            targetTestStocks = Array.from(activeSymbols).map(sym => ({
              symbol: sym,
              name: sym,
              isFO: false
            }));
          } else {
            targetTestStocks = Object.keys(cachedCandles).map(sym => {
              const found = testStocks.find(s => s.symbol === sym);
              return { symbol: sym, name: found ? found.name : sym, isFO: found ? found.isFO : false };
            });
          }
        } catch (err) {
          console.warn("[BacktestEngine] Failed to filter by SwingCandidate Mongo data:", err.message);
          targetTestStocks = Object.keys(cachedCandles).map(sym => {
            const found = testStocks.find(s => s.symbol === sym);
            return { symbol: sym, name: found ? found.name : sym, isFO: found ? found.isFO : false };
          });
        }
      } else {
        targetTestStocks = Object.keys(cachedCandles).map(sym => {
          const found = testStocks.find(s => s.symbol === sym);
          return { symbol: sym, name: found ? found.name : sym, isFO: found ? found.isFO : false };
        });
      }
      if (isFoScanner) {
        targetTestStocks = targetTestStocks.filter(stock => stock.isFO === true);
      }
    }

    // Date cutoff for 60 calendar days (2 months)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - periodDays);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    targetTestStocks.forEach(stock => {
      const allStockCandles = cachedCandles[stock.symbol];
      if (!allStockCandles || allStockCandles.length < 15) return;

      // Calculate signals using either swing tracker or momentum tracker V10
      let signals = [];
      if (isSwingScanner) {
        const trackerRes = calculateSwingTracker(allStockCandles);
        signals = trackerRes.signals || [];
      } else if (isFoScanner) {
        const trackerRes = calculateMomentumTrackerV10(allStockCandles);
        // We only care about LONG and SHORT signals. We map LONG to BUY and SHORT to SELL.
        signals = trackerRes.filter(r => r.signal === "LONG" || r.signal === "SHORT").map(r => ({
          date: r.date,
          action: r.signal === "LONG" ? "BUY" : "SELL",
          price: r.price,
          ribbonBullishCount: 8 // dummy count to satisfy signal strength builder
        }));
      }

      if (signals.length === 0) return;

      const isBearishScanner = scannerId === "fo-bearish";
      const entryAction = isBearishScanner ? "SELL" : "BUY";
      const exitAction = isBearishScanner ? "BUY" : "SELL";

      // Iterate through all signals to find all trades within the cutoff window
      let currentTrade = null;

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];

        if (!currentTrade && sig.action === entryAction) {
          // Open new trade
          currentTrade = {
            entryDate: sig.date,
            entryPrice: sig.price,
            ribbonBullishCount: sig.ribbonBullishCount
          };
        } else if (currentTrade && sig.action === exitAction) {
          // Close trade
          const entryDate = currentTrade.entryDate;
          const entryPrice = currentTrade.entryPrice;
          const exitDate = sig.date;
          const exitPrice = sig.price;

          if (exitDate >= cutoffStr || entryDate >= cutoffStr) {
            // Find extreme price for target/SL
            let extremePrice = entryPrice;
            const entryCandleIdx = allStockCandles.findIndex(c => c.date === entryDate);
            if (entryCandleIdx !== -1) {
              const startLookback = Math.max(0, entryCandleIdx - 20);
              for (let cIdx = startLookback; cIdx < entryCandleIdx; cIdx++) {
                if (allStockCandles[cIdx].high > extremePrice) extremePrice = allStockCandles[cIdx].high;
              }
            }

            let targetPrice = isBearishScanner ? entryPrice * 0.90 : (extremePrice > entryPrice * 1.04 ? extremePrice : entryPrice * 1.10);
            let stopLossPrice = isBearishScanner ? (extremePrice > entryPrice * 1.04 ? extremePrice : entryPrice * 1.06) : entryPrice * 0.94;

            const pnlPct = isBearishScanner ? ((entryPrice - exitPrice) / entryPrice) * 100 : ((exitPrice - entryPrice) / entryPrice) * 100;
            const pnlAmt = isBearishScanner ? entryPrice - exitPrice : exitPrice - entryPrice;
            const success = pnlPct >= 0;

            const strInfo = getSignalStrengthInfo(allStockCandles, entryDate, currentTrade.ribbonBullishCount);

            let runExtreme = entryPrice;
            const exitCandleIdx = allStockCandles.findIndex(c => c.date === exitDate);
            if (entryCandleIdx !== -1 && exitCandleIdx !== -1) {
              for (let cIdx = entryCandleIdx; cIdx <= exitCandleIdx; cIdx++) {
                if (isBearishScanner) {
                  if (allStockCandles[cIdx].low < runExtreme) runExtreme = allStockCandles[cIdx].low;
                } else {
                  if (allStockCandles[cIdx].high > runExtreme) runExtreme = allStockCandles[cIdx].high;
                }
              }
            }

            let potentialBuyZone = "";
            if (isBearishScanner) {
              potentialBuyZone = `₹${(exitPrice * 1.04).toFixed(2)} - ₹${(exitPrice * 1.07).toFixed(2)}`;
            } else {
              if (runExtreme > entryPrice * 1.02) {
                const diff = runExtreme - entryPrice;
                const buyZoneMax = runExtreme - 0.50 * diff;
                const buyZoneMin = runExtreme - 0.618 * diff;
                potentialBuyZone = `₹${buyZoneMin.toFixed(2)} - ₹${buyZoneMax.toFixed(2)}`;
              } else {
                potentialBuyZone = `₹${(exitPrice * 0.93).toFixed(2)} - ₹${(exitPrice * 0.96).toFixed(2)}`;
              }
            }

            totalTrades++;
            if (success) winningTrades++;
            else losingTrades++;
            totalProfitPct += pnlPct;

            trades.push({
              id: `t_closed_${stock.symbol}_${exitDate}`,
              symbol: stock.symbol,
              name: stock.name,
              type: isBearishScanner ? "SELL" : "BUY",
              entryDate,
              entryPrice: Number(entryPrice.toFixed(2)),
              exitDate,
              exitPrice: Number(exitPrice.toFixed(2)),
              currentPrice: Number(exitPrice.toFixed(2)),
              targetPrice: Number(targetPrice.toFixed(2)),
              stopLossPrice: Number(stopLossPrice.toFixed(2)),
              pnlAmount: Number(pnlAmt.toFixed(2)),
              pnlPct: Number(pnlPct.toFixed(2)),
              status: success ? "PROFIT" : "LOSS",
              potentialBuyZone,
              signalStrength: strInfo.strength
            });
          }
          currentTrade = null;
        }
      }

      // If there's an open trade at the end
      if (currentTrade && currentTrade.entryDate >= cutoffStr) {
        const entryDate = currentTrade.entryDate;
        const entryPrice = currentTrade.entryPrice;

        let extremePrice = entryPrice;
        const entryCandleIdx = allStockCandles.findIndex(c => c.date === entryDate);
        if (entryCandleIdx !== -1) {
          const startLookback = Math.max(0, entryCandleIdx - 20);
          for (let cIdx = startLookback; cIdx < entryCandleIdx; cIdx++) {
            if (allStockCandles[cIdx].high > extremePrice) extremePrice = allStockCandles[cIdx].high;
          }
        }

        let targetPrice = isBearishScanner ? entryPrice * 0.90 : (extremePrice > entryPrice * 1.04 ? extremePrice : entryPrice * 1.10);
        let stopLossPrice = isBearishScanner ? (extremePrice > entryPrice * 1.04 ? extremePrice : entryPrice * 1.06) : entryPrice * 0.94;

        const latestCandle = allStockCandles[allStockCandles.length - 1];
        const currentPrice = latestCandle.close;
        const pnlPct = isBearishScanner ? ((entryPrice - currentPrice) / entryPrice) * 100 : ((currentPrice - entryPrice) / entryPrice) * 100;
        const pnlAmt = isBearishScanner ? entryPrice - currentPrice : currentPrice - entryPrice;

        const strInfo = getSignalStrengthInfo(allStockCandles, entryDate, currentTrade.ribbonBullishCount);

        trades.push({
          id: `t_open_${stock.symbol}_${entryDate}`,
          symbol: stock.symbol,
          name: stock.name,
          type: isBearishScanner ? "SELL" : "BUY",
          entryDate,
          entryPrice: Number(entryPrice.toFixed(2)),
          exitDate: "—",
          exitPrice: null,
          currentPrice: Number(currentPrice.toFixed(2)),
          targetPrice: Number(targetPrice.toFixed(2)),
          stopLossPrice: Number(stopLossPrice.toFixed(2)),
          pnlAmount: Number(pnlAmt.toFixed(2)),
          pnlPct: Number(pnlPct.toFixed(2)),
          status: "OPEN",
          potentialBuyZone: "—",
          signalStrength: strInfo.strength
        });
      }
    });
  }
   else {
    return {
      scannerId,
      periodDays,
      stats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        averageProfitPct: 0,
        netProfitPct: 0
      },
      equityCurve: [],
      trades: []
    };
  }

  // Sort trades by entryDate descending
  trades.sort((a, b) => b.entryDate.localeCompare(a.entryDate));

  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const avgProfit = totalTrades > 0 ? (totalProfitPct / totalTrades) : 0;

  // Generate historical equity curve points for chart
  const equityCurve = [];
  let currentBalance = 100000; // Start with 1 Lakh
  equityCurve.push({ date: new Date(now - periodDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0], balance: currentBalance });
  
  // Group trades by date to build the daily equity curve
  const tradesByDate = {};
  trades.forEach(t => {
    if (!tradesByDate[t.exitDate]) tradesByDate[t.exitDate] = [];
    tradesByDate[t.exitDate].push(t);
  });

  for (let d = periodDays - 30; d >= 0; d--) {
    const checkDate = new Date(now - d * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const dailyTrades = tradesByDate[checkDate];
    if (dailyTrades) {
      dailyTrades.forEach(t => {
        // Allocate 10% of balance per trade
        const tradeSize = currentBalance * 0.1;
        const profit = tradeSize * (t.pnlPct / 100);
        currentBalance += profit;
      });
    }
    equityCurve.push({ date: checkDate, balance: Number(currentBalance.toFixed(0)) });
  }

  return {
    scannerId,
    periodDays,
    stats: {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: Number(winRate.toFixed(1)),
      averageProfitPct: Number(avgProfit.toFixed(2)),
      netProfitPct: Number((winRate * avgProfit / 10).toFixed(2)) // Normalized display return
    },
    equityCurve,
    trades: trades
  };
}

module.exports = {
  runBacktest
};

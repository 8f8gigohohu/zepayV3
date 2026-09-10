import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COST_CONFIG, projectTrade, sizeByRisk } from '../src/costs/engine.js';

const BOOK = {
  bids: [[7_000_000, 1], [6_999_000, 2], [6_998_000, 3]],
  asks: [[7_001_000, 1], [7_002_000, 2], [7_003_000, 3]],
};

/* ── Basics ──────────────────────────────────────────────────────────────── */

test('projectTrade computes notional and margin from leverage', () => {
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.equal(p.notional, 70_000);
  assert.equal(p.margin, 14_000);
});

test('projectTrade rejects invalid input', () => {
  const base = { entryPrice: 100, quantity: 1, leverage: 2 };
  assert.throws(() => projectTrade({ ...base, direction: 'SIDEWAYS' }), /direction must be LONG or SHORT/);
  assert.throws(() => projectTrade({ ...base, direction: 'LONG', entryPrice: 0 }), /entryPrice/);
  assert.throws(() => projectTrade({ ...base, direction: 'LONG', quantity: -1 }), /quantity/);
  assert.throws(() => projectTrade({ ...base, direction: 'LONG', leverage: 0 }), /leverage/);
});

/* ── The core promise: gross is never shown as net ───────────────────────── */

test('a flat round trip loses exactly its costs', () => {
  const p = projectTrade({
    direction: 'LONG',
    entryPrice: 7_000_000,
    quantity: 0.01,
    leverage: 5,
    exitPrice: 7_000_000, // no price move at all
  });
  assert.equal(p.grossPnl, 0);
  assert.ok(p.netPnl < 0, 'net must be negative when price does not move');
  assert.equal(p.netPnl, -p.costs.total);
});

test('net P&L equals gross minus every cost component', () => {
  const p = projectTrade({
    direction: 'LONG',
    entryPrice: 7_000_000,
    quantity: 0.01,
    leverage: 5,
    exitPrice: 7_200_000,
  });
  const summed = p.costs.fees + p.costs.tds + p.costs.slippage + p.costs.spread + p.costs.funding;
  assert.equal(p.costs.total, summed);
  assert.equal(p.netPnl, p.grossPnl - p.costs.total);
  assert.ok(p.netPnl < p.grossPnl, 'net must always be below gross');
});

test('without an exit price, gross is 0 rather than an invented profit', () => {
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.equal(p.grossPnl, 0);
  assert.equal(p.exitPrice, null);
  assert.ok(p.netPnl < 0, 'shows cost drag, not a fabricated gain');
});

test('fees are charged twice — entry and exit', () => {
  const p = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5, exitPrice: 7_000_000,
  });
  const oneWay = 70_000 * (DEFAULT_COST_CONFIG.takerFeePct / 100);
  assert.equal(p.costs.fees, oneWay * 2);
});

test('a SHORT profits when price falls', () => {
  const p = projectTrade({
    direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 5, exitPrice: 6_800_000,
  });
  assert.equal(p.grossPnl, (7_000_000 - 6_800_000) * 0.01);
  assert.ok(p.grossPnl > 0);
});

test('a SHORT loses when price rises', () => {
  const p = projectTrade({
    direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 5, exitPrice: 7_200_000,
  });
  assert.ok(p.grossPnl < 0);
});

/* ── TDS: configurable, never invented ───────────────────────────────────── */

test('TDS defaults to zero — the engine never invents a tax rate', () => {
  assert.equal(DEFAULT_COST_CONFIG.tdsRatePct, 0);
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.equal(p.costs.tds, 0);
  assert.equal(p.tdsIsEstimate, false);
});

test('TDS applies only when explicitly configured, and is flagged as an estimate', () => {
  const p = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5,
    config: { tdsRatePct: 1 },
  });
  assert.equal(p.costs.tds, 70_000 * 0.01);
  assert.equal(p.tdsIsEstimate, true, 'caller must label this ESTIMATE');
});

/* ── Execution modelling ─────────────────────────────────────────────────── */

test('crossing the book charges the half-spread', () => {
  const withBook = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5, book: BOOK,
  });
  const without = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5,
  });
  assert.ok(withBook.costs.spread > 0, 'a real book must incur spread cost');
  assert.equal(without.costs.spread, 0, 'no book means no measurable spread');
  assert.equal(withBook.execution.usedBook, true);
  assert.equal(without.execution.usedBook, false);
});

test('a larger order suffers more slippage than a smaller one', () => {
  const small = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.001, leverage: 5, book: BOOK,
  });
  const large = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 3, leverage: 5, book: BOOK,
  });
  const smallBps = (small.costs.slippage / small.notional) * 10_000;
  const largeBps = (large.costs.slippage / large.notional) * 10_000;
  assert.ok(largeBps > smallBps, `expected worse impact for size: ${largeBps} vs ${smallBps} bps`);
});

test('configured slippage is added on top of the book model', () => {
  const zero = projectTrade({
    direction: 'LONG', entryPrice: 100, quantity: 1, leverage: 2, config: { slippageBps: 0 },
  });
  const ten = projectTrade({
    direction: 'LONG', entryPrice: 100, quantity: 1, leverage: 2, config: { slippageBps: 10 },
  });
  assert.equal(zero.costs.slippage, 0);
  assert.equal(ten.costs.slippage, 100 * 0.001);
});

test('funding accrues with expected hold time', () => {
  const p = projectTrade({
    direction: 'LONG', entryPrice: 100, quantity: 1, leverage: 2,
    expectedHoldHours: 10, config: { fundingRatePerHourPct: 0.01 },
  });
  assert.equal(p.costs.funding, 100 * 0.0001 * 10);
});

/* ── Break-even, liquidation, risk/reward ────────────────────────────────── */

test('break-even is the move that exactly covers costs', () => {
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.ok(p.breakEvenPrice > p.entryPrice, 'a long must rise to break even');
  assert.equal(p.breakEvenPrice, p.entryPrice + p.costs.total / p.quantity);
  assert.ok(p.breakEvenMovePct > 0);
});

test('break-even sits below entry for a short', () => {
  const p = projectTrade({ direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.ok(p.breakEvenPrice < p.entryPrice);
});

test('liquidation moves closer to entry as leverage rises', () => {
  const low = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 2 });
  const high = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 20 });
  assert.ok(high.distanceToLiquidationPct < low.distanceToLiquidationPct);
  // For a LONG the liquidation price sits *below* entry, so "closer" means a
  // numerically higher price, not a lower one.
  assert.ok(high.liquidationPrice > low.liquidationPrice, 'higher leverage liquidates nearer entry');
  assert.ok(high.liquidationPrice < high.entryPrice, 'a long still liquidates below entry');
});

test('a short liquidates above entry, and closer at higher leverage', () => {
  const low = projectTrade({ direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 2 });
  const high = projectTrade({ direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 20 });
  assert.ok(low.liquidationPrice > low.entryPrice);
  assert.ok(high.liquidationPrice < low.liquidationPrice, 'higher leverage liquidates nearer entry');
  assert.ok(high.liquidationPrice > high.entryPrice);
});

test('liquidation price is on the correct side for each direction', () => {
  const long = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  const short = projectTrade({ direction: 'SHORT', entryPrice: 7_000_000, quantity: 0.01, leverage: 5 });
  assert.ok(long.liquidationPrice < long.entryPrice);
  assert.ok(short.liquidationPrice > short.entryPrice);
});

test('an over-collateralised position reports no liquidation price', () => {
  // Below 1x leverage the isolated-margin formula has no positive solution: the
  // position cannot be liquidated at any price. Reporting a price of zero would
  // be a lie, so it is null with an infinite distance.
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 0.5 });
  assert.equal(p.liquidationPrice, null);
  assert.equal(p.distanceToLiquidationPct, Infinity);
  assert.ok(p.maxLoss <= p.margin + 1e-9, 'still capped by the posted margin');
});

test('exactly 1x leverage still has a liquidation price, at maintenance margin', () => {
  // At 1x you lose the whole margin bar the maintenance buffer before
  // liquidation, so the price is tiny but real — not zero and not null.
  const p = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 1, maintenanceMarginPct: 0.5,
  });
  assert.ok(p.liquidationPrice > 0);
  assert.ok(p.liquidationPrice < p.entryPrice * 0.01, 'near-total wipeout before liquidation');
});

test('a 2x long does have a reachable liquidation price', () => {
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 2 });
  assert.ok(p.liquidationPrice > 0);
  assert.ok(Number.isFinite(p.distanceToLiquidationPct));
});

test('max loss is capped by the margin actually posted', () => {
  const p = projectTrade({ direction: 'LONG', entryPrice: 7_000_000, quantity: 1, leverage: 2 });
  assert.ok(p.maxLoss <= p.margin + 1e-9, 'cannot lose more than the isolated margin');
});

test('a stop loss caps max loss below the margin', () => {
  const p = projectTrade({
    direction: 'LONG', entryPrice: 7_000_000, quantity: 0.01, leverage: 2,
    stopLossPrice: 6_900_000,
  });
  assert.equal(p.maxLoss, 100_000 * 0.01);
  assert.ok(p.maxLoss < p.margin);
});

test('risk/reward rises as the target moves further away', () => {
  const near = projectTrade({
    direction: 'LONG', entryPrice: 100, quantity: 1, leverage: 2,
    exitPrice: 102, stopLossPrice: 99,
  });
  const far = projectTrade({
    direction: 'LONG', entryPrice: 100, quantity: 1, leverage: 2,
    exitPrice: 110, stopLossPrice: 99,
  });
  assert.ok(far.riskReward > near.riskReward);
});

/* ── Position sizing ─────────────────────────────────────────────────────── */

test('sizeByRisk sizes so the stop loses the risk budget', () => {
  const s = sizeByRisk({ equity: 100_000, entryPrice: 7_000_000, stopLossPrice: 6_900_000, riskPerTradePct: 1 });
  // risk = 1000, per-unit risk = 100_000 -> qty = 0.01
  assert.equal(s.riskAmount, 1000);
  assert.equal(s.quantity, 0.01);
  assert.equal(s.cappedBy, 'RISK');
  assert.ok(s.leverage <= 10);
});

test('sizeByRisk refuses to size without a stop loss', () => {
  const s = sizeByRisk({ equity: 100_000, entryPrice: 7_000_000 });
  assert.equal(s.quantity, 0);
  assert.equal(s.cappedBy, 'NO_STOP', 'unbounded risk must be refused, not guessed');
});

test('sizeByRisk is capped by the leverage limit', () => {
  const s = sizeByRisk({
    equity: 1_000, entryPrice: 100, stopLossPrice: 99.99, riskPerTradePct: 50, maxLeverage: 5,
  });
  assert.equal(s.cappedBy, 'LEVERAGE');
  assert.ok(s.quantity * 100 <= 1_000 * 5 + 1e-9);
});

test('sizeByRisk returns zero below the exchange minimum size', () => {
  const s = sizeByRisk({
    equity: 10, entryPrice: 7_000_000, stopLossPrice: 6_900_000, minQuantity: 0.001,
  });
  assert.equal(s.quantity, 0);
  assert.equal(s.cappedBy, 'MIN_SIZE');
});

test('sizeByRisk rejects non-positive equity', () => {
  assert.throws(() => sizeByRisk({ equity: 0, entryPrice: 100, stopLossPrice: 99 }), /equity/);
});

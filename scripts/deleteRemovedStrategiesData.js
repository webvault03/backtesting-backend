/**
 * Delete paper trades + wallets for removed strategies:
 * - OI Pulse Scalp (oi_pulse_scalp_live / paper_live_oi_pulse_scalp)
 * - FUT ΔOI Wall (fut_doi_wall_live / paper_live_fut_doi_wall)
 * - OI Wall Reaction (oi_wall_reaction_live / paper_live_oi_wall_reaction)
 * - Cover Impulse Scalp (cover_impulse_scalp_live / paper_live_cover_impulse_scalp)
 * - Trap Expansion (oi_trap_expansion_live / paper_live_oi_trap_expansion)
 * - OI Flow E/B (oi_flow_eb_live / paper_live_oi_flow_eb)
 * - Cover Scalp / OCC (oi_cover_chase_live / paper_live_oi_cover_chase)
 * - Flow Scalp E/B (flow_scalp_eb_live / paper_live_flow_scalp_eb) — 5m after SL, not Prime
 * - OI Wall Scalp (manual_oi_auto_live / paper_live_manual_oi_auto)
 * - Flow Match Scalp (flow_match_scalp_live / paper_live_flow_match_scalp)
 *
 * Usage: node scripts/deleteRemovedStrategiesData.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');

const STRATEGY_KEYS = [
  'oi_pulse_scalp_live',
  'fut_doi_wall_live',
  'oi_wall_reaction_live',
  'cover_impulse_scalp_live',
  'oi_trap_expansion_live',
  'oi_flow_eb_live',
  'oi_cover_chase_live',
  'flow_scalp_eb_live',
  'manual_oi_auto_live',
  'flow_match_scalp_live',
];
const WALLET_KEYS = [
  'paper_live_oi_pulse_scalp',
  'paper_live_fut_doi_wall',
  'paper_live_oi_wall_reaction',
  'paper_live_cover_impulse_scalp',
  'paper_live_oi_trap_expansion',
  'paper_live_oi_flow_eb',
  'paper_live_oi_cover_chase',
  'paper_live_flow_scalp_eb',
  'paper_live_manual_oi_auto',
  'paper_live_flow_match_scalp',
];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGODB_URI / MONGO_URI missing in .env');
  }
  await mongoose.connect(uri);

  const tradeFilter = {
    $or: [
      { strategyKey: { $in: STRATEGY_KEYS } },
      {
        strategyId: {
          $in: [
            'oi-pulse-scalp',
            'fut-doi-wall',
            'oi-wall-reaction',
            'cover-impulse-scalp',
            'oi-trap-expansion',
            'oi-flow-eb',
            'oi-cover-chase',
            'flow-scalp-eb',
            'manual-oi-auto',
            'flow-match-scalp',
          ],
        },
      },
      {
        notes:
          /oi_pulse_scalp|fut_doi_wall|oi_wall_reaction|cover_impulse_scalp|oi_trap_expansion|oi_flow_eb|oi_cover_chase|flow_scalp_eb|manual_oi_auto|flow_match_scalp/i,
      },
    ],
  };

  const tradeCount = await LivePaperTrade.countDocuments(tradeFilter);
  const tradeRes = await LivePaperTrade.deleteMany(tradeFilter);

  const walletCount = await LiveWallet.countDocuments({ walletKey: { $in: WALLET_KEYS } });
  const walletRes = await LiveWallet.deleteMany({ walletKey: { $in: WALLET_KEYS } });

  // Strip leftover settings fields from any remaining wallets (schema no longer defines them)
  const unsetRes = await LiveWallet.updateMany(
    {},
    {
      $unset: {
        futDoiWallEngineSettings: 1,
        oiPulseScalpEngineSettings: 1,
        oiWallReactionEngineSettings: 1,
        coverImpulseScalpEngineSettings: 1,
        oiTrapExpansionEngineSettings: 1,
        oiFlowEbEngineSettings: 1,
        oiCoverChaseEngineSettings: 1,
        flowScalpEbEngineSettings: 1,
        manualOiAutoEngineSettings: 1,
        flowMatchScalpEngineSettings: 1,
      },
    },
  );

  console.log(
    JSON.stringify(
      {
        tradesMatched: tradeCount,
        tradesDeleted: tradeRes.deletedCount,
        walletsMatched: walletCount,
        walletsDeleted: walletRes.deletedCount,
        walletsUnsetSettings: unsetRes.modifiedCount,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

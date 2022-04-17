import { METRICS } from "@connext/nxtp-utils";
import { BigNumber, constants } from "ethers";
import { Counter, Gauge } from "prom-client";

import {
  collectOnchainLiquidity,
  collectExpressiveLiquidity,
  getAssetName,
  collectGasBalance,
  collectRpcHeads,
  collectSubgraphHeads,
} from "../helpers/metrics";

//////////////////////////
///// Types
export const TransactionReasons = {
  PrepareReceiver: "PrepareReceiver",
  FulfillSender: "FulfillSender",
  CancelSender: "CancelSender",
  CancelReceiver: "CancelReceiver",
  Relay: "Relay",
} as const;

export type TransactionReason = typeof TransactionReasons[keyof typeof TransactionReasons];

export type ExpressiveAssetBalance<T = BigNumber> = {
  assetId: string;
  amount: T;
  supplied: T;
  locked: T;
  removed: T;
};

//////////////////////////
///// High Level Metrics

// Track the current onchain liquidity, will be set periodically based on
// what the subgraph values said. Subgraph querying logic is in the
// `collectCurrentLiquidity` helper function. NOTE: this is the available
// liquidity and does *not* include anything in the transfers
export const onchainLiquidity = new Gauge({
  name: "router_onchain_liquidity",
  help: "router_onchain_liquidity_help",
  labelNames: [METRICS.ChainId, METRICS.AssetId, METRICS.AssetName] as const,
  async collect() {
    const liquidity = await collectOnchainLiquidity();
    Object.entries(liquidity).map(([chainId, values]) => {
      values.map(({ assetId, amount }) => {
        this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, amount);
      });
    });
  },
});

// Track volume from receiver side (before fees). Incremented by the
// exit liquidity provided by router on transfer completion via the
// `incrementTotalTransferredVolume` function
export const totalTransferredVolume = new Counter({
  name: "router_transfer_volume",
  help: "router_transfer_volume_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.Amount,
    METRICS.AssetName,
  ] as const,
});

// Tracks balance for gas on native chains. This is given in the
// *native asset* amount rather than USD
export const gasBalance = new Gauge({
  name: "router_gas_balance",
  help: "router_gas_balance_help",
  labelNames: [METRICS.ChainId, METRICS.AssetName] as const,
  async collect() {
    const balances = await collectGasBalance();
    Object.entries(balances).map(([chainId, balance]) => {
      this.set({ chainId, assetName: getAssetName(constants.AddressZero, parseInt(chainId)) }, balance);
    });
  },
});

//////////////////////////
///// Infra

// Tracks the latest synced block on all rpcs
export const rpcHead = new Gauge({
  name: "rpc_head",
  help: "rpc_head_help",
  labelNames: [METRICS.ChainId],
  async collect() {
    const blocks = await collectRpcHeads();
    Object.entries(blocks).map(([chainId, blockNumber]) => {
      this.set({ chainId }, blockNumber);
    });
  },
});

// Tracks the latest synced block on all subgraphs
export const subgraphHead = new Gauge({
  name: "subgraph_head",
  help: "subgraph_head_help",
  labelNames: [METRICS.ChainId],
  async collect() {
    const blocks = await collectSubgraphHeads();
    Object.entries(blocks).map(([chainId, blockNumber]) => {
      this.set({ chainId }, blockNumber);
    });
  },
});

//////////////////////////
///// Auctions

// Incremented whenever an auction message is received
export const receivedAuction = new Counter({
  name: "router_auction_received",
  help: "router_auction_received_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.ReceivingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingChainId,
    METRICS.SendingAssetName,
    METRICS.ReceivingAssetName,
  ] as const,
});

// Incremented when an auction response is sent
export const attemptedAuction = new Counter({
  name: "router_auction_attempt",
  help: "router_auction_attempt_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.ReceivingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingChainId,
    METRICS.SendingAssetName,
    METRICS.ReceivingAssetName,
  ] as const,
});

// Incremented when receiver transaction first handled (either prepared or cancelled)
export const successfulAuction = new Counter({
  name: "router_auction_successful",
  help: "router_auction_successful_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.ReceivingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingChainId,
    METRICS.SendingAssetName,
    METRICS.ReceivingAssetName,
  ] as const,
});

//////////////////////////
///// Transfers

// Incremented when a transaction is successfully prepared
// and router funds are locked
export const attemptedTransfer = new Counter({
  name: "router_transfer_attempt",
  help: "router_transfer_attempt_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.ReceivingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingChainId,
    METRICS.SendingAssetName,
    METRICS.ReceivingAssetName,
  ] as const,
});

// Track completed transfers. Incremented when a router unlocks
// sender-side funds
export const completedTransfer = new Counter({
  name: "router_transfer_successful",
  help: "router_transfer_successful_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.ReceivingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingChainId,
    METRICS.SendingAssetName,
    METRICS.ReceivingAssetName,
  ] as const,
});

//////////////////////////
///// Financials

// Fees taken in USD -- incremented via `incrementFees` function that
// handles conversion
export const feesCollected = new Counter({
  name: "router_fees_usd",
  help: "router_fees_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetId,
    METRICS.ChainId,
    METRICS.AssetName,
  ] as const,
});

// Track gas consumed in USD -- incremented via `incrementGas` function that
// handles conversion.
export const gasConsumed = new Counter({
  name: "router_gas_consumed_usd",
  help: "router_gas_consumed_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.Reason,
    METRICS.ChainId,
  ] as const,
});

// Track fees paid to relayer in USD -- incremented via `incrementRelayerFeesPaid` function
// that handles conversion
export const relayerFeesPaid = new Counter({
  name: "relayer_fees_paid_usd",
  help: "relayer_fees_paid_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.Reason,
    METRICS.ChainId,
    METRICS.AssetId,
  ] as const,
});

// Track liquidity supplied (i.e. investment) in USD
// Collected via analytics subgraph
export const liquiditySupplied = new Gauge({
  name: "liquidity_supplied_usd",
  help: "liquidity_supplied_usd_help",
  labelNames: [METRICS.AssetId, METRICS.ChainId, METRICS.AssetName],
  async collect() {
    const liquidity = await collectExpressiveLiquidity();
    if (!liquidity) {
      return;
    }
    Object.entries(liquidity).map(([chainId, values]) => {
      values.map(({ assetId, supplied }) => {
        this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, supplied);
      });
    });
  },
});

// Track liquidity locked (i.e. in transfers) in USD
// Collected via analytics subgraph
export const liquidityLocked = new Gauge({
  name: "liquidity_locked_usd",
  help: "liquidity_locked_usd_help",
  labelNames: [METRICS.AssetId, METRICS.ChainId, METRICS.AssetName],
  async collect() {
    const liquidity = await collectExpressiveLiquidity();
    if (!liquidity) {
      return;
    }
    Object.entries(liquidity).map(([chainId, values]) => {
      values.map(({ assetId, locked }) => {
        this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, locked);
      });
    });
  },
});

// Track liquidity removed (i.e. in removeLiquidity) in USD
// Collected via analytics subgraph
export const liquidityRemoved = new Gauge({
  name: "liquidity_removed_usd",
  help: "liquidity_removed_usd_help",
  labelNames: [METRICS.AssetId, METRICS.ChainId, METRICS.AssetName],
  async collect() {
    const liquidity = await collectExpressiveLiquidity();
    if (!liquidity) {
      return;
    }
    Object.entries(liquidity).map(([chainId, values]) => {
      values.map(({ assetId, removed }) => {
        this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, removed);
      });
    });
  },
});

// // Track volume in (i.e. amounts in sender "prepare") in USD
// // Collected via analytics subgraph
// export const volumeIn = new Gauge({
//   name: "volume_in_usd",
//   help: "volume_in_usd_help",
//   labelNames: [METRICS.TransactionId, METRICS.SendingAssetId, METRICS.SendingChainId, METRICS.ReceivingAssetId, METRICS.ReceivingChainId, METRICS.AssetName],
//   async collect() {
//     const liquidity = await collectExpressiveLiquidity();
//     Object.entries(liquidity).map(([chainId, values]) => {
//       values.map(({ assetId, volumeIn }) => {
//         this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, volumeIn);
//       });
//     });
//   },
// });

// // Track volume (i.e. amounts in receiver "prepare") in USD
// // Collected via analytics subgraph
// export const volume = new Gauge({
//   name: "volume_usd",
//   help: "volume_usd_help",
//   labelNames: [METRICS.TransactionId, METRICS.SendingAssetId, METRICS.SendingChainId, METRICS.ReceivingAssetId, METRICS.ReceivingChainId, METRICS.AssetName],
//   async collect() {
//     const liquidity = await collectExpressiveLiquidity();
//     Object.entries(liquidity).map(([chainId, values]) => {
//       values.map(({ assetId, volume }) => {
//         this.set({ chainId, assetId, assetName: getAssetName(assetId, parseInt(chainId)) }, volume);
//       });
//     });
//   },
// });

//////////////////////////
///// Low Level

export const senderPrepared = new Counter({
  name: "sender_prepared",
  help: "sender_prepared_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverPrepared = new Counter({
  name: "receiver_prepared",
  help: "receiver_prepared_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const senderCancelled = new Counter({
  name: "sender_cancel",
  help: "sender_cancel_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverCancelled = new Counter({
  name: "receiver_cancel",
  help: "receiver_cancel_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const senderFulfilled = new Counter({
  name: "sender_fulfilled",
  help: "sender_fulfilled_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverFulfilled = new Counter({
  name: "receiver_fulfilled",
  help: "receiver_fulfilled_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const senderExpired = new Counter({
  name: "sender_expired",
  help: "sender_expired_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverExpired = new Counter({
  name: "receiver_expired",
  help: "receiver_expired_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverFailedPrepare = new Counter({
  name: "receiver_failed_prepare",
  help: "receiver_failed_prepare_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const senderFailedFulfill = new Counter({
  name: "sender_failed_fulfill",
  help: "sender_failed_fulfill_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const senderFailedCancel = new Counter({
  name: "sender_failed_cancel",
  help: "sender_failed_cancel_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

export const receiverFailedCancel = new Counter({
  name: "receiver_failed_cancel",
  help: "receiver_failed_cancel_help",
  labelNames: [
    METRICS.SendingAssetId,
    METRICS.SendingChainId,
    METRICS.ReceivingAssetId,
    METRICS.ReceivingChainId,
    METRICS.AssetName,
  ] as const,
});

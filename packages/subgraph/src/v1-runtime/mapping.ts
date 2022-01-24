/* eslint-disable prefer-const */
import { BigInt, Address, dataSource } from "@graphprotocol/graph-ts";

import {
  TransactionManager,
  LiquidityAdded,
  LiquidityRemoved,
  TransactionCancelled,
  TransactionFulfilled,
  TransactionPrepared,
} from "../../generated/TransactionManager/TransactionManager";
import { Transaction, AssetBalance, Router, User, Gas } from "../../generated/schema";

/**
 * Updates the subgraph records when LiquidityAdded events are emitted. Will create a Router record if it does not exist
 *
 * @param event - The contract event to update the subgraph record with
 */
export function handleLiquidityAdded(event: LiquidityAdded): void {
  let router = Router.load(event.params.router.toHex());
  if (router == null) {
    router = new Router(event.params.router.toHex());
    router.save();
  }

  // ID is of the format ROUTER_ADDRESS-ASSET_ID
  let assetBalanceId = event.params.assetId.toHex() + "-" + event.params.router.toHex();
  let assetBalance = AssetBalance.load(assetBalanceId);
  if (assetBalance == null) {
    assetBalance = new AssetBalance(assetBalanceId);
    assetBalance.assetId = event.params.assetId;
    assetBalance.router = router.id;
    assetBalance.amount = new BigInt(0);
  }
  // add new amount
  assetBalance.amount = assetBalance.amount.plus(event.params.amount);
  assetBalance.save();
}

/**
 * Updates the subgraph records when LiquidityRemoved events are emitted. Will create a Router record if it does not exist
 *
 * @param event - The contract event to update the subgraph record with
 */
export function handleLiquidityRemoved(event: LiquidityRemoved): void {
  let router = Router.load(event.params.router.toHex());
  if (router == null) {
    router = new Router(event.params.router.toHex());
    router.save();
  }

  // ID is of the format ROUTER_ADDRESS-ASSET_ID
  let assetBalanceId = event.params.assetId.toHex() + "-" + event.params.router.toHex();
  let assetBalance = AssetBalance.load(assetBalanceId);
  // add new amount
  assetBalance!.amount = assetBalance!.amount.minus(event.params.amount);
  assetBalance!.save();
}

/**
 * Creates subgraph records when TransactionPrepared events are emitted.
 *
 * @param event - The contract event used to create the subgraph record
 */
export function handleTransactionPrepared(event: TransactionPrepared): void {
  // load user and router
  // router should have liquidity but it may not
  const chainId = getChainId(event.address);
  let router = Router.load(event.params.txData.router.toHex());
  if (router == null) {
    router = new Router(event.params.txData.router.toHex());
    router.save();
  }

  let user = User.load(event.params.txData.user.toHex());
  if (user == null) {
    user = new User(event.params.txData.user.toHex());
    user.save();
  }
  // cannot use only transactionId because of multipath routing, this below combo will be unique for active txs
  let transactionId =
    event.params.transactionId.toHex() + "-" + event.params.user.toHex() + "-" + event.params.router.toHex();
  // contract checks ensure that this cannot exist at this point, so we can safely create new
  // NOTE: the above case is not always true since malicious users can reuse IDs to try to break the
  // subgraph. we can protect against this by overwriting if we are able to load a Transactioln
  let transaction = Transaction.load(transactionId);
  if (transaction == null) {
    transaction = new Transaction(transactionId);
  }

  // TransactionData
  transaction.receivingChainTxManagerAddress = event.params.txData.receivingChainTxManagerAddress;
  transaction.user = user.id;
  transaction.router = router.id;
  transaction.initiator = event.params.txData.initiator;
  transaction.sendingAssetId = event.params.txData.sendingAssetId;
  transaction.receivingAssetId = event.params.txData.receivingAssetId;
  transaction.sendingChainFallback = event.params.txData.sendingChainFallback;
  transaction.callTo = event.params.txData.callTo;
  transaction.receivingAddress = event.params.txData.receivingAddress;
  transaction.callDataHash = event.params.txData.callDataHash;
  transaction.transactionId = event.params.txData.transactionId;
  transaction.sendingChainId = event.params.txData.sendingChainId;
  transaction.receivingChainId = event.params.txData.receivingChainId;
  transaction.amount = event.params.txData.amount;
  transaction.expiry = event.params.txData.expiry;
  transaction.preparedBlockNumber = event.params.txData.preparedBlockNumber;

  // TransactionPrepared specific
  transaction.prepareCaller = event.params.caller;
  transaction.prepareTransactionHash = event.transaction.hash;
  transaction.encryptedCallData = event.params.args.encryptedCallData.toHexString();
  transaction.encodedBid = event.params.args.encodedBid.toHexString();
  transaction.bidSignature = event.params.args.bidSignature;

  // Meta
  transaction.prepareMeta = event.params.args.encodedMeta;
  transaction.status = "Prepared";
  transaction.chainId = chainId;
  transaction.preparedTimestamp = event.block.timestamp;

  transaction.save();

  // router is providing liquidity on receiver prepare
  if (chainId == transaction.receivingChainId) {
    let assetBalanceId = transaction.receivingAssetId.toHex() + "-" + event.params.router.toHex();
    let assetBalance = AssetBalance.load(assetBalanceId);
    assetBalance!.amount = assetBalance!.amount.minus(transaction.amount);
    assetBalance!.save();

    updateGas("receiving", "prepare", event.transaction.gasLimit);
  } else {
    updateGas("sending", "prepare", event.transaction.gasLimit);
  }
}

/**
 * Updates subgraph records when TransactionFulfilled events are emitted
 *
 * @param event - The contract event used to update the subgraph
 */
export function handleTransactionFulfilled(event: TransactionFulfilled): void {
  // contract checks ensure that this cannot exist at this point, so we can safely create new
  let transactionId =
    event.params.transactionId.toHex() + "-" + event.params.user.toHex() + "-" + event.params.router.toHex();
  let transaction = Transaction.load(transactionId);
  transaction!.status = "Fulfilled";
  transaction!.relayerFee = event.params.args.relayerFee;
  transaction!.signature = event.params.args.signature;
  transaction!.callData = event.params.args.callData.toHexString();
  transaction!.externalCallSuccess = event.params.success;
  transaction!.externalCallReturnData = event.params.returnData;
  transaction!.externalCallIsContract = event.params.isContract;
  transaction!.fulfillCaller = event.params.caller;
  transaction!.fulfillTransactionHash = event.transaction.hash;
  transaction!.fulfillMeta = event.params.args.encodedMeta;
  transaction!.fulfillTimestamp = event.block.timestamp;

  transaction!.save();

  // router receives liquidity back on sender fulfill
  if (transaction!.chainId == transaction!.sendingChainId) {
    let assetBalanceId = transaction!.sendingAssetId.toHex() + "-" + event.params.router.toHex();
    let assetBalance = AssetBalance.load(assetBalanceId);
    if (assetBalance == null) {
      assetBalance = new AssetBalance(assetBalanceId);
      assetBalance.assetId = transaction!.sendingAssetId;
      assetBalance.router = event.params.router.toHex();
      assetBalance.amount = new BigInt(0);
    }
    assetBalance.amount = assetBalance.amount.plus(transaction!.amount);
    assetBalance.save();

    updateGas("sending", "fulfill", event.transaction.gasLimit);
  } else {
    updateGas("receiving", "fulfill", event.transaction.gasLimit);
  }
}

/**
 * Updates subgraph records when TransactionCancelled events are emitted
 *
 * @param event - The contract event used to update the subgraph
 */
export function handleTransactionCancelled(event: TransactionCancelled): void {
  // contract checks ensure that this cannot exist at this point, so we can safely create new
  let transactionId =
    event.params.transactionId.toHex() + "-" + event.params.user.toHex() + "-" + event.params.router.toHex();
  let transaction = Transaction.load(transactionId);
  transaction!.status = "Cancelled";
  transaction!.cancelCaller = event.params.caller;
  transaction!.cancelTransactionHash = event.transaction.hash;
  transaction!.cancelMeta = event.params.args.encodedMeta;
  transaction!.cancelTimestamp = event.block.timestamp;

  transaction!.save();

  // router receives liquidity back on receiver cancel
  if (transaction!.chainId == transaction!.receivingChainId) {
    let assetBalanceId = transaction!.receivingAssetId.toHex() + "-" + event.params.router.toHex();
    let assetBalance = AssetBalance.load(assetBalanceId);
    if (assetBalance == null) {
      assetBalance = new AssetBalance(assetBalanceId);
      assetBalance.assetId = transaction!.receivingAssetId;
      assetBalance.router = event.params.router.toHex();
      assetBalance.amount = new BigInt(0);
    }
    assetBalance.amount = assetBalance.amount.plus(transaction!.amount);
    assetBalance.save();

    updateGas("receiving", "cancel", event.transaction.gasLimit);
  } else {
    updateGas("sending", "cancel", event.transaction.gasLimit);
  }
}

function getChainId(transactionManagerAddress: Address): BigInt {
  // try to get chainId from the mapping
  let network = dataSource.network();
  let chainId: BigInt;
  if (network == "mainnet") {
    chainId = BigInt.fromI32(1);
  } else if (network == "ropsten") {
    chainId = BigInt.fromI32(3);
  } else if (network == "rinkeby") {
    chainId = BigInt.fromI32(4);
  } else if (network == "goerli") {
    chainId = BigInt.fromI32(5);
  } else if (network == "kovan") {
    chainId = BigInt.fromI32(42);
  } else if (network == "bsc") {
    chainId = BigInt.fromI32(56);
  } else if (network == "chapel") {
    chainId = BigInt.fromI32(97);
  } else if (network == "xdai") {
    chainId = BigInt.fromI32(100);
  } else if (network == "matic") {
    chainId = BigInt.fromI32(137);
  } else if (network == "fantom") {
    chainId = BigInt.fromI32(250);
  } else if (network == "mbase") {
    chainId = BigInt.fromI32(1287);
  } else if (network == "arbitrum-one") {
    chainId = BigInt.fromI32(42161);
  } else if (network == "fuji") {
    chainId = BigInt.fromI32(43113);
  } else if (network == "avalanche") {
    chainId = BigInt.fromI32(43114);
  } else if (network == "mumbai") {
    chainId = BigInt.fromI32(80001);
  } else if (network == "arbitrum-rinkeby") {
    chainId = BigInt.fromI32(421611);
  } else {
    // instantiate contract to get the chainId as a fallback
    chainId = TransactionManager.bind(transactionManagerAddress).getChainId();
  }

  return chainId;
}

function updateGas(side: string, method: string, gasLimit: BigInt): void {
  let gasId = side + "-" + method;

  const length = new BigInt(100);
  let gas = Gas.load(gasId.toString());
  if (gas == null) {
    gas = new Gas(gasId.toString());
    gas.gasLimitRecordLastHundred = [];
    gas.gasLimitAverageLastHundered = new BigInt(0);
  }

  let records = gas.gasLimitRecordLastHundred;
  const recordsLength = new BigInt(records.length);
  if (recordsLength >= length) {
    records.shift();
  }
  records.push(gasLimit);

  const total = records.reduce((a, b) => a.plus(b), 0);
  gas.gasLimitAverageLastHundered = new BigInt(total / records.length);
  gas.gasLimitRecordLastHundred = records;

  gas.save();
}
